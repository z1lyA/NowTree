mod commands;
mod db;
mod models;
mod reminder;

use db::Db;
use tauri::Emitter;
use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};

// 0.2.0：最小化到托盘。
// 把主窗口的「关闭(X)」拦截为「隐藏到托盘」；托盘菜单提供「显示 / 退出」，双击托盘恢复窗口。
// 单一实例保护：重复双击 exe 时唤起已运行窗口而非再起一个进程（避免两个进程抢同一份 SQLite 锁）。
fn focus_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // Windows 下隐藏窗口时需从任务栏移除残影；显示时再放回。
        #[cfg(target_os = "windows")]
        let _ = w.set_skip_taskbar(false);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// 1.1.5：把主窗口「强制提到最前」。
// 用于关闭确认框：窗口可能被压在其它程序下面（或已最小化），只 emit 事件用户根本看不见。
// 提供两档：
//   - bring_main_front：只激活（供弹窗「打开 NowTree / 去整理」使用，不改变窗口层级）；
//   - bring_main_front_topmost：额外临时置顶（供关闭确认框使用，取消后由 release_main_topmost 解除）。
pub(crate) fn bring_main_front(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        #[cfg(target_os = "windows")]
        let _ = w.set_skip_taskbar(false);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub(crate) fn bring_main_front_topmost(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        #[cfg(target_os = "windows")]
        let _ = w.set_skip_taskbar(false);
        let _ = w.show();
        let _ = w.unminimize();
        // set_focus 是尽力而为（Windows 前台锁可能拒绝抢焦点），因此额外临时置顶，
        // 保证确认框一定可见；用户选完 / 取消后由 release_main_topmost 解除置顶。
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // 单一实例：第二个实例唤起第一个、自己退出（防双击 exe 抢锁）。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main(app);
        }))
        // 1.1.7：应用内检查更新。
        // 更新源是 GitHub Release 上的静态 latest.json（见 tauri.conf.json 的 endpoints）；
        // 安装包必须由私钥签名，运行时用 pubkey 校验，校验不通过一律拒绝安装。
        // 不注册 tauri-plugin-process：Windows 安装器装完会自动重启应用
        // （InstallOptions.restartAfterInstall 默认 true），无需前端 relaunch()。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let db = Db::new(&handle).expect("failed to open database");
            db.init().expect("failed to init database");
            app.manage(db);
            // 1.1.5：提醒弹窗的暂存队列 / 就绪标记（卡片投递走 reminder.rs）
            app.manage(reminder::ReminderState::default());

            // 0.2.0：托盘图标 + 右键菜单（显示 / 退出）+ 双击恢复。
            // 托盘图标直接复用窗口图标（default_window_icon），无需单独资源文件。
            let show_i =
                MenuItem::with_id(&handle, "show", "显示 NowTree", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(&handle, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(&handle, &[&show_i, &quit_i])?;
            let _tray = TrayIconBuilder::with_id("nowtree-tray")
                .icon(
                    handle
                        .default_window_icon()
                        .cloned()
                        .expect("window icon missing"),
                )
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("NowTree")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => focus_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick { .. } = event {
                        focus_main(tray.app_handle());
                    }
                })
                .build(&handle)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_transactions,
            commands::get_transaction,
            commands::create_transaction,
            commands::update_transaction,
            commands::delete_transaction,
            commands::convert_inbox,
            commands::list_deleted,
            commands::restore_transaction,
            commands::purge_transaction,
            commands::empty_trash,
            commands::reset_all_data,
            commands::export_data,
            commands::import_data,
            commands::get_autostart,
            commands::set_autostart,
            // 1.1.7：系统深浅色（WebView2 的 prefers-color-scheme 不可信，改由注册表读）
            commands::get_system_theme,
            commands::minimize_to_tray,
            commands::quit_app,
            commands::read_backup_meta,
            // 1.1.5：关闭确认时把主窗口提到最前 / 解除临时置顶
            commands::bring_main_to_front,
            commands::release_main_topmost,
            // 1.1.5：右下角自定义提醒弹窗（卡片投递 / 取件 / 自适应高度 / 隐藏 / 唤起主窗口）
            reminder::show_reminder_cards,
            reminder::take_reminder_cards,
            reminder::fit_reminder_window,
            reminder::hide_reminder_window,
            reminder::show_main_window,
            reminder::schedule_reminder_fire,
        ])
        // 0.2.0：拦截窗口关闭事件 —— 不立即关闭/隐藏，先通知前端弹确认框，
        // 由用户选择「最小化到托盘」或「退出」，再 invoke 对应命令真正执行。
        .build(tauri::generate_context!())
        .expect("error while building NowTree")
        .run(|app, event| {
            if let tauri::RunEvent::WindowEvent { label, event: we, .. } = event {
                if let tauri::WindowEvent::CloseRequested { api, .. } = we {
                    if label == "main" {
                        // 阻止真正关闭，仅通知前端；真正的 hide / exit 由前端 invoke 命令执行。
                        api.prevent_close();
                        let _ = app.emit("window-close-requested", ());
                    }
                }
            }
        });
}
