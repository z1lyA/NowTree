// 1.1.5：右下角自定义提醒弹窗的窗口管理（替代 Windows 系统通知）。
//
// 设计：
//   - 独立无边框窗口（label = "reminder"），加载前端页面 reminder.html；
//   - 窗口常驻复用：第一次需要提醒时创建并隐藏加载，之后只 show/hide；
//   - 位置 / 宽度由主窗口随每次投递传入（设置里的「弹窗个性化」）：四角可选、可调宽度；
//   - 贴屏幕「工作区」角落（work_area 已排除任务栏），不抢焦点、不进任务栏；
//   - 全屏应用在前台时**先排队不打扰**：卡片暂存，退出全屏后（约 2 秒内）再正常弹出；
//   - 主窗口（React）通过命令 show_reminder_cards 投递卡片；窗口页面挂载时用
//     take_reminder_cards 取走「建窗前就已在排队」的卡片，之后的新卡片走事件推送。
//
// 为什么要 pending + ready：
//   建窗到页面挂载之间有一小段时间，期间投递的卡片若只 emit 会丢；
//   故 ready 之前先暂存，页面挂载取走后置 ready，之后只走事件（避免陈旧卡片重放）。
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

pub const REMINDER_LABEL: &str = "reminder";
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

#[derive(Default)]
pub struct ReminderState {
    // 建窗后、页面挂载前投递的卡片暂存区
    pending: Mutex<Vec<ReminderCard>>,
    // 页面是否已完成首次挂载取件
    ready: AtomicBool,
    // 最近一次投递带入的布局（fit_reminder_window 调高度时沿用）
    layout: Mutex<ReminderLayout>,
    // 全屏期间暂存的卡片（退出全屏后统一弹出）
    deferred: Mutex<Vec<ReminderCard>>,
    // 是否已有线程在等全屏结束（防止重复起线程）
    defer_monitor: AtomicBool,
    // 精确提醒定时器的代际号：新计划会让旧的睡眠线程自然失效
    timer_gen: AtomicU64,
}

// 创建（或复用）提醒窗口。首次创建前先置 ready=false，等待页面挂载取走 pending。
// 注意顺序：必须在 build 之前复位 ready——页面可能在 build 返回前就完成挂载并取件，
// 若之后再置 false，会把已就绪状态覆盖掉，后续卡片只会进 pending 而无人取。
fn ensure_window(app: &AppHandle, width: f64) -> Result<WebviewWindow, String> {
    if let Some(win) = app.get_webview_window(REMINDER_LABEL) {
        return Ok(win);
    }
    if let Some(state) = app.try_state::<ReminderState>() {
        state.ready.store(false, Ordering::SeqCst);
    }
    let win = WebviewWindowBuilder::new(
        app,
        REMINDER_LABEL,
        WebviewUrl::App("reminder.html".into()),
    )
    .title("NowTree 提醒")
    .inner_size(width, 160.0)
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
    Ok(win)
}

// 取窗口所在屏（多屏时用窗口当前所在屏；取不到则回落主屏）。
fn monitor_of(app: &AppHandle, win: &WebviewWindow) -> Result<(tauri::Monitor, f64), String> {
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| "未找到可用显示器".to_string())?;
    let scale = monitor.scale_factor();
    Ok((monitor, scale))
}

// 按布局把窗口贴到所选角落（工作区已排除任务栏）。
fn place_window(
    win: &WebviewWindow,
    monitor: &tauri::Monitor,
    scale: f64,
    layout: &ReminderLayout,
    height_px: i32,
) -> Result<(), String> {
    let area = monitor.work_area();
    let margin = (layout.margin * scale).round() as i32;
    let width = (layout.width * scale).round() as i32;
    let left = area.position.x + margin;
    let top = area.position.y + margin;
    let right = area.position.x + area.size.width as i32 - width - margin;
    let bottom = area.position.y + area.size.height as i32 - height_px - margin;
    let (x, y) = match layout.corner.as_str() {
        "top-left" => (left, top),
        "top-right" => (right, top),
        "bottom-left" => (left, bottom),
        _ => (right, bottom),
    };
    win.set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
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

// 把卡片真正交付给提醒窗口：必要时建窗、按布局贴边、显示、推送。
// 本函数会创建 WebView2 窗口，只能从**非主线程**调用（async 命令线程 / 后台线程）。
fn deliver_cards(
    app: &AppHandle,
    cards: Vec<ReminderCard>,
    layout: ReminderLayout,
) -> Result<(), String> {
    let state = app.state::<ReminderState>();
    let win = ensure_window(app, layout.width)?;
    // ready 的检查与 pending 的写入必须在同一把锁里完成：
    //   - 页面 take（同样持锁：置 ready + 取走 pending）与这里互斥，
    //     要么卡片进 pending 被页面取走，要么页面已就绪、这里直接 emit，不会两头落空。
    let should_emit = {
        let mut pending = state.pending.lock().unwrap_or_else(|e| e.into_inner());
        if state.ready.load(Ordering::SeqCst) {
            true
        } else {
            pending.extend(cards.iter().cloned());
            false
        }
    };

    let (monitor, scale) = monitor_of(app, &win)?;
    // 应用最新宽度（高度保持现状，页面稍后会按内容 fit）
    let current_height = win
        .outer_size()
        .map(|s| s.height as f64 / scale)
        .unwrap_or(160.0)
        .max(MIN_HEIGHT);
    let _ = win.set_size(LogicalSize::new(layout.width, current_height));
    // 走到这里说明当前不在全屏：恢复置顶（但仍不抢焦点）
    let _ = win.set_always_on_top(true);
    place_window(
        &win,
        &monitor,
        scale,
        &layout,
        (current_height * scale).round() as i32,
    )?;
    // 先显示再推送：窗口被隐藏时 WebView2 可能处于后台节流状态，
    // 先把窗口显示出来再 emit，页面恢复执行后一定能收到事件。
    set_visible_without_activation(&win, true)?;
    if should_emit {
        app.emit_to(REMINDER_LABEL, "nowtree:reminder-push", &cards)
            .map_err(|e| e.to_string())?;
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
            if let Err(e) = deliver_cards(&app, cards, layout) {
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

    deliver_cards(&app, cards, layout)
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

// 弹窗页面挂载时取走暂存卡片，并标记就绪。
#[tauri::command]
pub fn take_reminder_cards(state: State<'_, ReminderState>) -> Vec<ReminderCard> {
    let mut guard = state.pending.lock().unwrap_or_else(|e| e.into_inner());
    state.ready.store(true, Ordering::SeqCst);
    std::mem::take(&mut *guard)
}

// 页面内容高度变化后调整窗口高度（宽度 / 角落沿用最近一次布局）并保持贴边。
#[tauri::command]
pub fn fit_reminder_window(app: AppHandle, height: f64) -> Result<(), String> {
    let Some(win) = app.get_webview_window(REMINDER_LABEL) else {
        return Ok(());
    };
    let state = app.state::<ReminderState>();
    let layout = state
        .layout
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let clamped = height.clamp(MIN_HEIGHT, MAX_HEIGHT);
    let (monitor, scale) = monitor_of(&app, &win)?;
    win.set_size(LogicalSize::new(layout.width, clamped))
        .map_err(|e| e.to_string())?;
    place_window(
        &win,
        &monitor,
        scale,
        &layout,
        (clamped * scale).round() as i32,
    )
}

// 卡片清空 / 自动收起时隐藏窗口（保留窗口复用，下次直接显示）。
#[tauri::command]
pub fn hide_reminder_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(REMINDER_LABEL) {
        set_visible_without_activation(&win, false)?;
    }
    Ok(())
}

// 「开始今天 / 去整理」：把主窗口拉到前台。
#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    crate::bring_main_front(&app);
}
