// 1.1.5：右下角自定义提醒弹窗的窗口管理（替代 Windows 系统通知）。
//
// 设计（1.1.9 起改为「一卡一窗口」）：
//   - 每张卡片占一个独立无边框窗口，标签 reminder-0 / reminder-1 / …（槽位池化，最多 MAX_SLOTS 个）；
//   - 窗口常驻复用：卡片关闭只隐藏窗口，之后的新卡片直接复用同一窗口，不反复创建 webview；
//   - 多个窗口自上而下**纵向排列、不重叠**，间距 STACK_GAP；贴屏幕「工作区」角落（已排除任务栏），
//     不抢焦点、不进任务栏；
//   - 位置 / 宽度由主窗口随每次投递传入（设置里的「弹窗个性化」）：四角可选、可调宽度；
//   - 全屏应用在前台时**先排队不打扰**：卡片暂存，退出全屏后再逐个弹出；
//   - 主窗口（React）通过命令 show_reminder_cards 投递卡片；各窗口页面挂载时用
//     take_reminder_card 取走本槽「建窗前就已在排队」的卡片，之后的新卡片走事件推送。
//
// 为什么从「一窗多卡」改成「一卡一窗」：每张卡独立存在（各自可拖动、各自计时收起），
// 窗口内那套假堆叠 / 悬浮展开 / 计数条一并去掉。代价是每个窗口各有一个 WebView2 渲染实例。
//
// 为什么要 per-slot 的 pending + ready：
//   建窗到页面挂载之间有一小段时间，期间投递的卡片若只 emit 会丢；
//   故该槽 ready 之前先存进 pending，页面取走后置 ready，之后只走事件（避免陈旧卡片重放）。
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

// 窗口标签前缀：完整标签是 `reminder-<槽位序号>`。
const LABEL_PREFIX: &str = "reminder-";
// 并发弹窗上限（每多一个窗口就多一个 WebView2 渲染实例，不宜无限开）。
const MAX_SLOTS: usize = 6;
// 相邻卡片的纵向间距（逻辑像素）。
const STACK_GAP: f64 = 8.0;
// 页面首次上报真实高度前的占位高度（逻辑像素）：先按它排布，收到 fit 后立刻纠正。
const DEFAULT_HEIGHT: f64 = 140.0;
const MIN_WIDTH: f64 = 300.0;
const MAX_WIDTH: f64 = 520.0;
const MIN_HEIGHT: f64 = 60.0;
const MAX_HEIGHT: f64 = 720.0;
const MIN_MARGIN: f64 = 0.0;
const MAX_MARGIN: f64 = 200.0;

// 卡片数据：与前端 src/services/reminderCards.ts 的 ReminderCard 一一对应。
// camelCase：前端字段是 dateText，Rust 侧写 date_text，序列化后自动对齐。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderCard {
    pub key: String,
    pub kind: String,
    #[serde(default)]
    pub id: Option<i64>,
    pub title: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub tasks: Option<Vec<String>>,
    #[serde(default)]
    pub count: Option<i64>,
    #[serde(default)]
    pub slot: Option<String>,
    #[serde(default)]
    pub quote: Option<String>,
    #[serde(default)]
    pub date_text: Option<String>,
    // 设置里的「预览」实验卡：页面只展示关闭按钮
    #[serde(default)]
    pub preview: Option<bool>,
}

// 弹窗个性化里与「窗口几何」相关的部分（前端 utils/reminderPrefs.ts 的 ReminderLayout）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderLayout {
    // "top-left" | "top-right" | "bottom-left" | "bottom-right"
    pub corner: String,
    pub width: f64,
    // 距工作区边缘的间距（逻辑像素）
    pub margin: f64,
}

impl Default for ReminderLayout {
    fn default() -> Self {
        Self {
            corner: "bottom-right".to_string(),
            width: 380.0,
            margin: 40.0,
        }
    }
}

fn normalize_layout(layout: ReminderLayout) -> ReminderLayout {
    let corner = match layout.corner.as_str() {
        "top-left" | "top-right" | "bottom-left" | "bottom-right" => layout.corner,
        _ => "bottom-right".to_string(),
    };
    ReminderLayout {
        corner,
        width: layout.width.clamp(MIN_WIDTH, MAX_WIDTH),
        margin: layout.margin.clamp(MIN_MARGIN, MAX_MARGIN),
    }
}

// 单个槽位（= 一个窗口）的状态。
#[derive(Debug, Clone)]
struct Slot {
    // 当前占用该槽的卡片 key；None 表示空闲可复用
    key: Option<String>,
    // 页面挂载前暂存的卡片
    pending: Option<ReminderCard>,
    // 该槽页面是否已完成首次挂载取件
    ready: bool,
    // 页面上报的内容高度（逻辑像素），用于纵向排布
    height: f64,
    // 到达顺序（单调递增）。排布按它排序，而不是按槽位序号：
    // 复用中间空出来的槽时，新卡仍然排到最末，不会「插」到别的卡中间造成视觉上的顶替。
    order: u64,
}

impl Default for Slot {
    fn default() -> Self {
        Self {
            key: None,
            pending: None,
            ready: false,
            height: DEFAULT_HEIGHT,
            order: 0,
        }
    }
}

#[derive(Default)]
pub struct ReminderState {
    // 最近一次投递带入的布局（排布窗口时沿用）
    layout: Mutex<ReminderLayout>,
    // 槽位池：索引即窗口序号
    slots: Mutex<Vec<Slot>>,
    // 到达顺序发号器（见 Slot::order）
    order_gen: AtomicU64,
    // 槽位全满时的排队卡片（有槽位空出来会补位）
    overflow: Mutex<Vec<ReminderCard>>,
    // 全屏期间暂存的卡片（退出全屏后统一弹出）
    deferred: Mutex<Vec<ReminderCard>>,
    // 是否已有线程在等全屏结束（防止重复起线程）
    defer_monitor: AtomicBool,
    // 精确提醒定时器的代际号：新计划会让旧的睡眠线程自然失效
    timer_gen: AtomicU64,
}

fn slot_label(index: usize) -> String {
    format!("{LABEL_PREFIX}{index}")
}

// 从窗口标签解析槽位序号（非提醒窗口返回 None）。
fn slot_index_of_label(label: &str) -> Option<usize> {
    label.strip_prefix(LABEL_PREFIX)?.parse::<usize>().ok()
}

// 创建（或复用）某槽位的窗口。页面在 build 返回后异步挂载，此窗口先保持隐藏。
fn ensure_slot_window(
    app: &AppHandle,
    index: usize,
    width: f64,
) -> Result<WebviewWindow, String> {
    let label = slot_label(index);
    if let Some(win) = app.get_webview_window(&label) {
        return Ok(win);
    }
    let win = WebviewWindowBuilder::new(app, label, WebviewUrl::App("reminder.html".into()))
        .title("NowTree 提醒")
        .inner_size(width, DEFAULT_HEIGHT)
        .min_inner_size(width, MIN_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| format!("创建提醒窗口失败：{e}"))?;
    // DWM 系统圆角：窗口属性，每个窗口各设一次
    apply_system_corner(&win);
    Ok(win)
}

// 取主屏与缩放比：所有提醒窗口都贴在同一个工作区，多屏时统一用主屏。
fn monitor_and_scale(app: &AppHandle) -> Result<(tauri::Monitor, f64), String> {
    let monitor = app
        .primary_monitor()
        .ok()
        .flatten()
        .ok_or_else(|| "未找到可用显示器".to_string())?;
    let scale = monitor.scale_factor();
    Ok((monitor, scale))
}

// 按当前占用情况重排所有提醒窗口：同侧纵向排列、互不重叠，整体贴所选角落。
// 卡片高度各不相同，所以每次增删卡片或高度变化都要重算全部 y 坐标。
fn relayout(app: &AppHandle, layout: &ReminderLayout) -> Result<(), String> {
    // 收集占用中的槽位及其高度，按「到达顺序」排序（不是槽位序号）：
    // 复用中间空出的槽时，新卡要排到最末，而不是插到原有卡片中间。
    let entries: Vec<(usize, f64)> = {
        let state = app.state::<ReminderState>();
        let slots = state.slots.lock().unwrap_or_else(|e| e.into_inner());
        let mut occupied: Vec<(usize, u64, f64)> = slots
            .iter()
            .enumerate()
            .filter(|(_, s)| s.key.is_some())
            .map(|(i, s)| {
                let h = if s.height > 0.0 { s.height } else { DEFAULT_HEIGHT };
                (i, s.order, h)
            })
            .collect();
        occupied.sort_by_key(|(_, order, _)| *order);
        occupied.into_iter().map(|(i, _, h)| (i, h)).collect()
    };
    if entries.is_empty() {
        return Ok(());
    }

    let (monitor, scale) = monitor_and_scale(app)?;
    let area = monitor.work_area();
    let margin = (layout.margin * scale).round() as i32;
    let width_px = (layout.width * scale).round() as i32;
    let gap_px = (STACK_GAP * scale).round() as i32;

    // 左列贴左边、右列贴右边（宽度固定，四种角落只影响左右与纵向起点）
    let x = match layout.corner.as_str() {
        "top-left" | "bottom-left" => area.position.x + margin,
        _ => area.position.x + area.size.width as i32 - width_px - margin,
    };
    // 纵向：从下往上贴边时，整体高度要先算出来才知道起点
    let total_px: i32 = entries
        .iter()
        .map(|(_, h)| (h * scale).round() as i32)
        .sum::<i32>()
        + gap_px * (entries.len() as i32 - 1);
    let mut y = match layout.corner.as_str() {
        "top-left" | "top-right" => area.position.y + margin,
        _ => area.position.y + area.size.height as i32 - margin - total_px,
    };

    for (index, height) in entries {
        if let Some(win) = app.get_webview_window(&slot_label(index)) {
            let _ = win.set_size(LogicalSize::new(layout.width, height));
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
        y += (height * scale).round() as i32 + gap_px;
    }
    Ok(())
}

// 当前前台是否为全屏应用（含 F11 全屏 / 视频 / 演示模式）。
// 用 SHQueryUserNotificationState：Windows 官方用于判断「现在是否适合弹通知」的接口。
#[cfg(target_os = "windows")]
fn foreground_fullscreen() -> bool {
    use windows::Win32::UI::Shell::{
        SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE,
        QUNS_RUNNING_D3D_FULL_SCREEN,
    };
    match unsafe { SHQueryUserNotificationState() } {
        Ok(state) => {
            state.0 == QUNS_BUSY.0
                || state.0 == QUNS_RUNNING_D3D_FULL_SCREEN.0
                || state.0 == QUNS_PRESENTATION_MODE.0
        }
        Err(_) => false,
    }
}

#[cfg(not(target_os = "windows"))]
fn foreground_fullscreen() -> bool {
    false
}

// 显示 / 隐藏窗口但**不触碰焦点**。
// 为什么不用 win.show() / win.hide()：
//   - tao 只在「首次显示」时走 SW_SHOWNOACTIVATE（MARKER_DONT_FOCUS 随即被清掉），
//     之后再 show() 走 SW_SHOW，可能把焦点从主窗口 / 其它程序抢走——提醒是后台事件，不能打断输入；
//   - 若只对 show 走 Win32、hide 仍走 tao，tao 内部「可见」状态没被更新，hide() 会因为
//     flags 无差异直接 return，窗口反而关不掉。
// 因此这里 show / hide 统一走 Win32，tao 的可见状态始终视为「隐藏」，不影响其它逻辑
// （本项目不依赖 window.is_visible()）。
#[cfg(target_os = "windows")]
fn set_visible_without_activation(win: &WebviewWindow, visible: bool) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE, SW_SHOWNOACTIVATE};
    let hwnd = win.hwnd().map_err(|e| e.to_string())?;
    unsafe {
        let _ = ShowWindow(hwnd, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE });
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn set_visible_without_activation(win: &WebviewWindow, visible: bool) -> Result<(), String> {
    if visible {
        win.show().map_err(|e| e.to_string())
    } else {
        win.hide().map_err(|e| e.to_string())
    }
}

// 用 DWM 系统圆角替代 GDI region：GDI region 是二值裁剪，圆角边缘呈台阶状锯齿；
// DWMWA_WINDOW_CORNER_PREFERENCE 让 DWM 在合成层画圆角，有 GPU 抗锯齿，边缘平滑。
// 这是窗口属性，设一次即可（不像 region 要在尺寸变化后重套）。
// 代价：半径由系统决定、不可调；且对无边框窗口是否生效需实机验证。
#[cfg(target_os = "windows")]
fn apply_system_corner(win: &WebviewWindow) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };

    let Ok(hwnd) = win.hwnd() else { return };
    let pref = DWMWCP_ROUND.0;
    // DWM 圆角偏好自 Win11 起生效；旧系统或不支持时静默忽略，退回方角
    let _ = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &pref as *const i32 as *const core::ffi::c_void,
            std::mem::size_of::<i32>() as u32,
        )
    };
}

#[cfg(not(target_os = "windows"))]
fn apply_system_corner(_win: &WebviewWindow) {}

// 把一批卡片分配到各槽位并显示。
// 关键：建窗必须放在持锁之外——建窗期间页面可能立刻调用 take_reminder_card 去取 pending，
// 全程持锁会自我死锁。
fn assign_cards(
    app: &AppHandle,
    cards: Vec<ReminderCard>,
    layout: ReminderLayout,
) -> Result<(), String> {
    let state = app.state::<ReminderState>();
    let mut need_create: Vec<usize> = Vec::new();
    let mut to_emit: Vec<(usize, ReminderCard)> = Vec::new();
    let mut overflowed = 0usize;

    {
        let mut slots = state.slots.lock().unwrap_or_else(|e| e.into_inner());
        let mut overflow = state.overflow.lock().unwrap_or_else(|e| e.into_inner());
        for card in cards {
            // 同 key 已占某槽：视为更新，直接推给该窗口
            if let Some(idx) = slots
                .iter()
                .position(|s| s.key.as_deref() == Some(card.key.as_str()))
            {
                if slots[idx].ready {
                    to_emit.push((idx, card));
                } else {
                    slots[idx].pending = Some(card);
                }
                continue;
            }
            // 找空闲槽；槽位池未满则扩容，全满则排队
            let idx = match slots.iter().position(|s| s.key.is_none()) {
                Some(i) => i,
                None if slots.len() < MAX_SLOTS => {
                    slots.push(Slot::default());
                    slots.len() - 1
                }
                None => {
                    overflow.push(card);
                    overflowed += 1;
                    continue;
                }
            };
            slots[idx].key = Some(card.key.clone());
            // 发一个到达序号：后续排布按它排序，确保新卡总在末尾
            slots[idx].order = state.order_gen.fetch_add(1, Ordering::SeqCst);
            let exists = app.get_webview_window(&slot_label(idx)).is_some();
            if exists && slots[idx].ready {
                to_emit.push((idx, card));
            } else {
                slots[idx].ready = false;
                slots[idx].pending = Some(card);
                if !exists {
                    need_create.push(idx);
                }
            }
        }
    }

    // 建窗（锁已释放）
    for idx in &need_create {
        ensure_slot_window(app, *idx, layout.width)?;
    }

    // 先排布；**新建的窗口不在这里显示**——页面挂载取到卡片时才显示（见 take_reminder_card），
    // 否则会先露出一块空白窗口底再等页面渲染，观感像闪了一下灰块。
    relayout(app, &layout)?;

    let mut reveal: Vec<usize> = to_emit.iter().map(|(i, _)| *i).collect();
    reveal.sort_unstable();
    reveal.dedup();
    for idx in reveal {
        if let Some(win) = app.get_webview_window(&slot_label(idx)) {
            // 走到这里说明当前不在全屏：恢复置顶（但仍不抢焦点）
            let _ = win.set_always_on_top(true);
            let _ = set_visible_without_activation(&win, true);
        }
    }

    for (idx, card) in to_emit {
        let label = slot_label(idx);
        app.emit_to(label.as_str(), "nowtree:reminder-push", &card)
            .map_err(|e| e.to_string())?;
    }

    if overflowed > 0 {
        eprintln!("[NowTree] 提醒槽位已满（上限 {MAX_SLOTS}），{overflowed} 张卡片排入队列");
    }
    Ok(())
}

// 全屏监测线程：每 2 秒看一次前台是否仍是全屏；一旦退出全屏，就把暂存卡片统一弹出并结束线程。
fn spawn_defer_monitor(app: AppHandle) {
    let state = app.state::<ReminderState>();
    if state.defer_monitor.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        let state = app.state::<ReminderState>();
        let has_deferred = !state
            .deferred
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty();
        if !has_deferred {
            state.defer_monitor.store(false, Ordering::SeqCst);
            return;
        }
        if foreground_fullscreen() {
            continue;
        }
        let cards: Vec<ReminderCard> = {
            let mut deferred = state.deferred.lock().unwrap_or_else(|e| e.into_inner());
            std::mem::take(&mut *deferred)
        };
        let layout = state
            .layout
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        state.defer_monitor.store(false, Ordering::SeqCst);
        if !cards.is_empty() {
            if let Err(e) = assign_cards(&app, cards, layout) {
                eprintln!("[NowTree] 退出全屏后弹出提醒失败：{e}");
            }
        }
        return;
    });
}

// 主窗口投递卡片：不在全屏则立即弹出；全屏则先排队，退出全屏后再弹（不打扰全屏应用）。
//
// ⚠️ 必须是 async 命令：Tauri 文档明确「Windows 下在同步命令 / 事件处理器里创建窗口会死锁」
// （WebView2 的 CreateCoreWebView2Controller 不能在 WebView2 自己的回调栈里重入调用）。
// async 命令跑在异步运行时线程上，build() 会把消息投递给主线程并等待，窗口才能正常创建。
#[tauri::command]
pub async fn show_reminder_cards(
    app: AppHandle,
    cards: Vec<ReminderCard>,
    layout: Option<ReminderLayout>,
    state: State<'_, ReminderState>,
) -> Result<(), String> {
    if cards.is_empty() {
        return Ok(());
    }
    // 记录本次布局（偏好改了，下一次投递即生效）
    if let Some(l) = layout {
        *state.layout.lock().unwrap_or_else(|e| e.into_inner()) = normalize_layout(l);
    }
    let layout = state
        .layout
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();

    if foreground_fullscreen() {
        // 全屏中：只排队，不建窗、不显示、不抢焦点。
        state
            .deferred
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .extend(cards);
        drop(state);
        spawn_defer_monitor(app);
        return Ok(());
    }

    assign_cards(&app, cards, layout)
}

// 精确提醒定时器：前端算出「最近一条提醒」的 epoch 毫秒，这里睡到点后通知主窗口去扫描，
// 不再等 30 秒轮询（30 秒轮询仍保留为兜底）。at_ms 传 null 表示取消当前计划。
#[tauri::command]
pub fn schedule_reminder_fire(
    app: AppHandle,
    at_ms: Option<i64>,
    state: State<'_, ReminderState>,
) {
    let generation = state.timer_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let Some(at_ms) = at_ms else {
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        // 分片睡眠：每 1.5 秒醒一次检查代际号，被新计划取代时能尽快退出，
        // 避免频繁改提醒时间时留下一堆长睡线程。
        loop {
            let now = chrono::Utc::now().timestamp_millis();
            if at_ms <= now {
                break;
            }
            let remaining = (at_ms - now) as u64;
            std::thread::sleep(Duration::from_millis(remaining.min(1500)));
            let state = app.state::<ReminderState>();
            if state.timer_gen.load(Ordering::SeqCst) != generation {
                return;
            }
        }
        let state = app.state::<ReminderState>();
        // 期间又有新的计划（提醒时间被改 / 新增 / 删除）→ 本次作废
        if state.timer_gen.load(Ordering::SeqCst) != generation {
            return;
        }
        let _ = app.emit_to("main", "nowtree:reminder-due", ());
    });
}

// 弹窗页面挂载时取走本槽的暂存卡片，并标记该槽就绪。
// 槽位由窗口标签推导，页面不需要传参。
//
// 显示时机放在这里而不是建窗处：此刻页面已挂载、卡片马上渲染，
// 显示出来就是内容而不是一块空白窗口底（建窗即显示会闪一下灰块）。
#[tauri::command]
pub fn take_reminder_card(
    window: WebviewWindow,
    state: State<'_, ReminderState>,
) -> Option<ReminderCard> {
    let idx = slot_index_of_label(window.label())?;
    let card = {
        let mut slots = state.slots.lock().unwrap_or_else(|e| e.into_inner());
        let slot = slots.get_mut(idx)?;
        slot.ready = true;
        slot.pending.take()
    };
    if card.is_some() {
        let _ = window.set_always_on_top(true);
        let _ = set_visible_without_activation(&window, true);
    }
    card
}

// 页面内容高度变化后重排所有提醒窗口（纵向不重叠），保持贴边。
// 只做尺寸 / 位置更新，**不显示窗口**——显示只在投递卡片时发生，避免关闭后又被顶出来。
#[tauri::command]
pub fn fit_reminder_card(
    app: AppHandle,
    window: WebviewWindow,
    height: f64,
) -> Result<(), String> {
    let Some(idx) = slot_index_of_label(window.label()) else {
        return Ok(());
    };
    let state = app.state::<ReminderState>();
    let layout = state
        .layout
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    {
        let mut slots = state.slots.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = slots.get_mut(idx) {
            slot.height = height.clamp(MIN_HEIGHT, MAX_HEIGHT);
        }
    }
    relayout(&app, &layout)
}

// 关闭本窗口的卡片：立即隐藏窗口（保留复用），空出的槽位由排队卡片补位，然后重排。
#[tauri::command]
pub fn close_reminder_card(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let Some(idx) = slot_index_of_label(window.label()) else {
        return Ok(());
    };
    let state = app.state::<ReminderState>();
    let layout = state
        .layout
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();

    // 先隐藏，避免重排时用户看到窗口缩成一条
    let _ = set_visible_without_activation(&window, false);

    let mut promoted: Option<ReminderCard> = None;
    {
        let mut slots = state.slots.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = slots.get_mut(idx) {
            slot.key = None;
            slot.pending = None;
            slot.height = DEFAULT_HEIGHT;
            slot.order = 0;
            // 排队卡片补位到刚空出的槽（窗口仍在且页面已就绪，直接推事件即可）
            let mut overflow = state.overflow.lock().unwrap_or_else(|e| e.into_inner());
            if !overflow.is_empty() {
                let card = overflow.remove(0);
                slot.key = Some(card.key.clone());
                // 补位卡也是「刚到」，取新序号保证排到末尾
                slot.order = state.order_gen.fetch_add(1, Ordering::SeqCst);
                slot.height = DEFAULT_HEIGHT;
                promoted = Some(card);
            }
        }
    }

    if let Some(card) = promoted {
        let label = slot_label(idx);
        let _ = app.emit_to(label.as_str(), "nowtree:reminder-push", &card);
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.set_always_on_top(true);
            let _ = set_visible_without_activation(&win, true);
        }
    }

    relayout(&app, &layout)
}

// 「开始今天 / 去整理」：把主窗口拉到前台。
#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    crate::bring_main_front(&app);
}
