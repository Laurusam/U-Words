//! macOS 原生浮窗动效层（路线 B）：胶囊壳 + 13 根波形 bar + 出场/形变/退场动画
//! 运行在 Core Animation 层，脱离 WebView 合成管线。
//!
//! 架构（设计稿见 plans / 交接文档）：
//! - 宿主：layer-hosting NSView，挂在 wry 的 WryWebViewParent 下、显式位于 WKWebView 之下
//!   （transparent 窗的 webview drawsBackground=false，原生层可透出）。
//! - 时钟：CVDisplayLink 只当起搏器——回调线程仅合并唤醒标志，实际 tick 经
//!   AppHandle::run_on_main_thread 回主线程执行（读写层 + 引擎推进都在主线程）。
//! - 状态：Engine + Host 同驻 thread_local（AppKit 对象 MainThreadOnly，不能进 managed state）；
//!   跨线程只有 EffectsState 的原子量（enabled/level/theme，main.rs 定义）。
//! - 弹簧：effects_spring.rs 纯函数，cancel = 移除且不触发完成回调（穿透恢复语义依赖此）。
//! - 鼠标穿透：形变期由 Rust 侧 set_ignore_cursor_events 控制（前端 JS 调用被 ACL 拒绝，
//!   属历史死代码，本模块迁入后首次真正生效）。
//! - Windows：EffectsState 与纯函数模块全平台编译；本文件 macOS 主体 cfg 门控，
//!   非 macOS 提供同名命令与入口的空实现，前端据 Err 哨兵/flag=false 走旧路径。

use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
mod imp {
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use std::time::Instant;

    use objc2::rc::Retained;
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSAutoresizingMaskOptions, NSView, NSWindowOrderingMode, NSWorkspace};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_core_graphics::CGColor;
    use objc2_quartz_core::{CALayer, CATransaction, CATransform3D};
    use tauri::{AppHandle, Emitter, Manager};

    use crate::effects_geom::{self, ShellGeom, BAR_COUNT};
    use crate::effects_spring::{Spring, SPRING_POP, SPRING_SETTLE, clamp_dt, css_ease};
    use crate::EffectsState;

    // ---------- 主题色（对齐 styles.css --ov-* 与 accent） ----------

    struct ThemeColors {
        shell_bg: (f64, f64, f64, f64),
        line: (f64, f64, f64, f64),
        accent: (f64, f64, f64, f64),
    }

    const DARK: ThemeColors = ThemeColors {
        shell_bg: (23.0 / 255.0, 23.0 / 255.0, 22.0 / 255.0, 0.82),
        line: (0x56 as f64 / 255.0, 0x56 as f64 / 255.0, 0x56 as f64 / 255.0, 1.0),
        accent: (238.0 / 255.0, 238.0 / 255.0, 236.0 / 255.0, 1.0),
    };

    const LIGHT: ThemeColors = ThemeColors {
        shell_bg: (251.0 / 255.0, 251.0 / 255.0, 249.0 / 255.0, 0.84),
        line: (0x88 as f64 / 255.0, 0x88 as f64 / 255.0, 0x88 as f64 / 255.0, 1.0),
        accent: (35.0 / 255.0, 35.0 / 255.0, 32.0 / 255.0, 1.0),
    };

    fn theme_colors(theme: u8) -> ThemeColors {
        if theme == 1 { LIGHT } else { DARK }
    }

    // ---------- 阶段 ----------

    #[derive(Clone, Copy, PartialEq, Debug)]
    pub enum Stage {
        Idle,
        Record,
        Process,
        Flash,
        Text,
        Preview,
        Image,
    }

    fn parse_stage(raw: &str) -> Stage {
        match raw {
            "record" => Stage::Record,
            "process" => Stage::Process,
            "flash" => Stage::Flash,
            "text" => Stage::Text,
            "preview" => Stage::Preview,
            "image" => Stage::Image,
            _ => Stage::Idle,
        }
    }

    /// 进入/退出的当前变换值（scale、CSS y 偏移、opacity）；由 enter 或 exit 弹簧驱动。
    #[derive(Clone, Copy)]
    struct Xform {
        scale: f64,
        y: f64,
        opacity: f64,
    }

    impl Xform {
        const IDENTITY: Xform = Xform { scale: 1.0, y: 0.0, opacity: 1.0 };
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Phase {
        Hidden,
        Visible,
    }

    struct Engine {
        stage: Stage,
        phase: Phase,
        shell: ShellGeom,
        xf: Xform,
        enter: Option<[Spring; 3]>,
        morph: Option<[Spring; 3]>,
        exit: Option<[Spring; 2]>,
        sink_started: Option<Instant>,
        /// 全 bar 共用的平滑电平（一阶低通 tau=45ms，对齐 webview transition .045s）
        level_smoothed: f64,
        bar_opacity: f64,
        quiet_frames: u32,
        passthrough_armed: bool,
        last_tick: Option<Instant>,
    }

    impl Engine {
        fn new() -> Self {
            Self {
                stage: Stage::Idle,
                phase: Phase::Hidden,
                shell: effects_geom::GEOM_CAPSULE,
                xf: Xform::IDENTITY,
                enter: None,
                morph: None,
                exit: None,
                sink_started: None,
                level_smoothed: 0.0,
                bar_opacity: 0.45,
                quiet_frames: 0,
                passthrough_armed: false,
                last_tick: None,
            }
        }

        fn activity(&self) -> bool {
            self.enter.is_some()
                || self.morph.is_some()
                || self.exit.is_some()
                || self.sink_started.is_some()
                || (self.stage == Stage::Record && self.quiet_frames <= 13)
        }

        /// 取消全部动画：不触发任何完成回调；穿透立即恢复（幂等，对应 restoreCursorRef 语义）。
        /// 返回是否需要恢复穿透。
        fn cancel_anims(&mut self) -> bool {
            self.enter = None;
            self.morph = None;
            self.exit = None;
            self.sink_started = None;
            std::mem::replace(&mut self.passthrough_armed, false)
        }
    }

    // ---------- 宿主（层树，主线程独占） ----------

    struct Host {
        host_view: Retained<NSView>,
        root_layer: Retained<CALayer>,
        shell_layer: Retained<CALayer>,
        bar_layers: Vec<Retained<CALayer>>,
        webview_layer: Retained<CALayer>,
        scale: f64,
    }

    /// WKWebView 层是否跟随壳做 enter/exit 变换（等价现状“壳+内容一体变换”）。
    /// 若真机发现与 WebKit 合成冲突，置 false 退化为“内容不跟随”。
    const WEBVIEW_XFORM_SYNC: bool = true;

    impl Host {
        fn apply_theme(&self, theme: u8) {
            let colors = theme_colors(theme);
            CATransaction::begin();
            CATransaction::setDisableActions(true);
            self.shell_layer.setBackgroundColor(Some(&CGColor::new_srgb(
                colors.shell_bg.0, colors.shell_bg.1, colors.shell_bg.2, colors.shell_bg.3,
            )));
            self.shell_layer.setBorderColor(Some(&CGColor::new_srgb(
                colors.line.0, colors.line.1, colors.line.2, colors.line.3,
            )));
            for bar in &self.bar_layers {
                bar.setBackgroundColor(Some(&CGColor::new_srgb(
                    colors.accent.0, colors.accent.1, colors.accent.2, colors.accent.3,
                )));
            }
            CATransaction::commit();
        }
    }

    // ---------- 全局状态 ----------

    static APP: OnceLock<AppHandle> = OnceLock::new();
    static WAKE: AtomicBool = AtomicBool::new(false);
    static TIMING: AtomicBool = AtomicBool::new(false);

    thread_local! {
        static HOST: RefCell<Option<(Engine, Host)>> = const { RefCell::new(None) };
    }

    fn with_native<R>(f: impl FnOnce(&mut Engine, &mut Host) -> R) -> Option<R> {
        HOST.with_borrow_mut(|slot| slot.as_mut().map(|(engine, host)| f(engine, host)))
    }

    // ---------- 节拍线程（起搏器） ----------

    // 注：原设计用 CVDisplayLink 做起搏器，真机（macOS 26）实测创建/Start 均返回成功但回调
    // 从不触发（未文档化行为）。改为普通节拍线程：8ms 睡眠上限 ≈ 125Hz 脉冲上限，实际帧率
    // 由主线程 tick 的 dispatch 延迟决定（~60-120Hz）；dt 在 tick 内用 Instant 实测并钳制，
    // 弹簧行为与显示时钟无关。WAKE 合并未消费的脉冲，主线程忙时不堆积。

    /// 需要节拍的标记：ensure_pacer 置 true；on_display_tick 发现无活动时置 false，线程自灭
    static PACING: AtomicBool = AtomicBool::new(false);

    fn ensure_pacer() {
        if PACING.swap(true, Ordering::AcqRel) {
            return; // 线程已在跑
        }
        let spawned = std::thread::Builder::new()
            .name("uwords-effects-pacer".into())
            .spawn(|| {
                let mut last_pulse = Instant::now();
                while PACING.load(Ordering::Relaxed) {
                    let elapsed = last_pulse.elapsed();
                    let period = std::time::Duration::from_millis(8);
                    if elapsed < period {
                        std::thread::sleep(period - elapsed);
                        continue;
                    }
                    last_pulse = Instant::now();
                    // WAKE 合并：上一 tick 未消费时不再投递
                    if !WAKE.swap(true, Ordering::AcqRel) {
                        if let Some(app) = APP.get() {
                            let _ = app.run_on_main_thread(on_display_tick);
                        } else {
                            break;
                        }
                    }
                }
            });
        if let Err(error) = spawned {
            PACING.store(false, Ordering::Relaxed);
            eprintln!("[effects] 节拍线程启动失败：{error}");
        }
    }

    // ---------- 主线程 tick ----------

    fn on_display_tick() {
        WAKE.store(false, Ordering::Release);
        let timing = TIMING.load(Ordering::Relaxed);
        if timing {
            static TICKS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let n = TICKS.fetch_add(1, Ordering::Relaxed);
            if n == 0 {
                eprintln!("[effects-dbg] 首个主线程 tick 执行");
            }
        }
        let started = Instant::now();
        let active = with_native(|engine, host| {
            let now = Instant::now();
            let dt = clamp_dt(now.duration_since(engine.last_tick.unwrap_or(now)).as_secs_f64());
            engine.last_tick = Some(now);
            let level = level_from_state();
            tick(engine, host, dt, level);
            if timing {
                static DIAG: AtomicBool = AtomicBool::new(false);
                if !DIAG.swap(true, Ordering::Relaxed) {
                    let vb = host.host_view.bounds();
                    let rb = host.root_layer.bounds();
                    let sf = host.shell_layer.frame();
                    eprintln!(
                        "[effects-dbg] 诊断：view {:.0}x{:.0} | root {:.0}x{:.0} | shell frame ({:.1},{:.1},{:.1},{:.1}) hidden={:?} opacity={:.2} bg已设={} root子层数={:?}",
                        vb.size.width, vb.size.height,
                        rb.size.width, rb.size.height,
                        sf.origin.x, sf.origin.y, sf.size.width, sf.size.height,
                        host.shell_layer.isHidden(), host.shell_layer.opacity(),
                        host.shell_layer.backgroundColor().is_some(),
                        unsafe { host.root_layer.sublayers().map(|s| s.len()) },
                    );
                }
            }
            engine.activity()
        })
        .unwrap_or(false);
        if timing {
            record_timing_sample(started.elapsed().as_secs_f64() * 1000.0);
        }
        if !active {
            // 空闲：节拍线程自灭（PACING 置 false 后循环退出）
            PACING.store(false, Ordering::Relaxed);
        }
    }

    fn level_from_state() -> f64 {
        APP.get()
            .and_then(|app| app.try_state::<EffectsState>())
            .map(|state| f32::from_bits(state.level_bits.load(Ordering::Relaxed)) as f64)
            .unwrap_or(0.0)
    }

    /// 推进引擎并写入层。
    fn tick(engine: &mut Engine, host: &mut Host, dt: f64, level: f64) {
        // 电平低通（对齐 webview 侧 transform transition .045s）与静音变暗（.08s）
        let alpha = 1.0 - (-dt / 0.045).exp();
        engine.level_smoothed += (level - engine.level_smoothed) * alpha;
        let live = engine.level_smoothed > 0.02;
        let opacity_target = if live { 1.0 } else { 0.45 };
        let opacity_alpha = 1.0 - (-dt / 0.08).exp();
        engine.bar_opacity += (opacity_target - engine.bar_opacity) * opacity_alpha;
        if live {
            engine.quiet_frames = 0;
        } else {
            engine.quiet_frames = engine.quiet_frames.saturating_add(1);
        }

        // enter 弹簧：scale .6→1 / y 14→0 / opacity 0→1
        if let Some(springs) = engine.enter.as_mut() {
            let mut done = 0;
            for spring in springs.iter_mut() {
                if spring.step(dt) {
                    done += 1;
                }
            }
            engine.xf.scale = springs[0].value;
            engine.xf.y = springs[1].value;
            engine.xf.opacity = springs[2].value;
            if done == 3 {
                engine.enter = None;
            }
        } else if let Some(springs) = engine.exit.as_mut() {
            // exit 弹簧：scale→.85 / opacity→0
            let mut done = 0;
            for spring in springs.iter_mut() {
                if spring.step(dt) {
                    done += 1;
                }
            }
            engine.xf.scale = springs[0].value;
            engine.xf.opacity = springs[1].value;
            if done == 2 {
                engine.exit = None;
                finalize_exit(engine, host);
                return;
            }
        }

        // morph 弹簧：壳 w/h/radius
        if let Some(springs) = engine.morph.as_mut() {
            let mut done = 0;
            for spring in springs.iter_mut() {
                if spring.step(dt) {
                    done += 1;
                }
            }
            engine.shell.width = springs[0].value;
            engine.shell.height = springs[1].value;
            engine.shell.radius = springs[2].value;
            if done == 3 && engine.passthrough_armed {
                engine.passthrough_armed = false;
                set_passthrough(false);
            }
        }

        // bar 逐根沉降完成（最晚一根 12*12ms stagger + 200ms）→ 隐藏 bar
        if let Some(started) = engine.sink_started {
            if started.elapsed().as_secs_f64() >= 0.012 * (BAR_COUNT as f64 - 1.0) + 0.2 {
                engine.sink_started = None;
                CATransaction::begin();
                CATransaction::setDisableActions(true);
                for bar in &host.bar_layers {
                    bar.setHidden(true);
                }
                CATransaction::commit();
            }
        }

        apply_frame(engine, host);
    }

    /// 把引擎当前值写入全部层（单帧一次 CATransaction）。
    fn apply_frame(engine: &Engine, host: &mut Host) {
        let view_bounds = host.host_view.bounds();
        let (view_w, _) = (view_bounds.size.width, view_bounds.size.height);
        let current_scale = view_scale(&host.host_view);
        if host.scale != current_scale {
            host.scale = current_scale;
            host.root_layer.setContentsScale(host.scale);
        }
        CATransaction::begin();
        CATransaction::setDisableActions(true);

        // 壳：窗口底部居中（AppKit y 向上，底部 1pt 内边距，对齐 webview padding 0 1px 1px）
        let frame = CGRect::new(
            CGPoint::new((view_w - engine.shell.width) / 2.0, 1.0),
            CGSize::new(engine.shell.width, engine.shell.height),
        );
        host.shell_layer.setFrame(frame);
        host.shell_layer.setCornerRadius(engine.shell.radius);

        let sink_elapsed = engine.sink_started.map(|at| at.elapsed().as_secs_f64());
        let smoothed = engine.level_smoothed;
        for (index, bar) in host.bar_layers.iter().enumerate() {
            let x = frame.origin.x + effects_geom::bar_center_x(index, BAR_COUNT, engine.shell.width);
            let y = frame.origin.y + effects_geom::bar_center_y(engine.shell.height);
            bar.setPosition(CGPoint::new(x, y));
            let mut scale = effects_geom::bar_scale(smoothed, index, BAR_COUNT);
            let mut opacity = engine.bar_opacity;
            if let Some(elapsed) = sink_elapsed {
                // 逐根沉降：start = index*12ms，200ms css_ease → scaleY .14 / opacity .45
                let t = ((elapsed - index as f64 * 0.012) / 0.2).clamp(0.0, 1.0);
                let eased = css_ease(t);
                scale += (0.14 - scale) * eased;
                opacity += (0.45 - opacity) * eased;
            }
            bar.setTransform(CATransform3D::new_scale(1.0, scale, 1.0));
            bar.setOpacity(opacity as f32);
        }

        // 壳变换（enter/exit 驱动），webview 内容层可选跟随
        let mid_x = frame.origin.x + frame.size.width / 2.0;
        let mid_y = frame.origin.y + frame.size.height / 2.0;
        let transform = xform_matrix(mid_x, mid_y, engine.xf);
        host.shell_layer.setTransform(transform);
        host.shell_layer.setOpacity(engine.xf.opacity as f32);
        if WEBVIEW_XFORM_SYNC {
            host.webview_layer.setTransform(transform);
            host.webview_layer.setOpacity(engine.xf.opacity as f32);
        }

        CATransaction::commit();
    }

    fn xform_matrix(mid_x: f64, mid_y: f64, xf: Xform) -> CATransform3D {
        // p' = S(p - c) + c + (0, -y)（CSS y 向下 = layer y 取负）
        let to_center = CATransform3D::new_translation(mid_x, mid_y, 0.0);
        let scale = CATransform3D::new_scale(xf.scale, xf.scale, 1.0);
        let from_center = CATransform3D::new_translation(-mid_x, -mid_y, 0.0);
        let shift = CATransform3D::new_translation(0.0, -xf.y, 0.0);
        shift.concat(to_center.concat(scale.concat(from_center)))
    }

    /// webview 层复位（隐藏/收尾后下次 show 前也由 prepare_show 覆写）。
    fn reset_webview_layer(host: &Host) {
        CATransaction::begin();
        CATransaction::setDisableActions(true);
        host.shell_layer.setHidden(true);
        for bar in &host.bar_layers {
            bar.setHidden(true);
        }
        host.webview_layer.setTransform(CATransform3D::new_scale(1.0, 1.0, 1.0));
        host.webview_layer.setOpacity(1.0);
        CATransaction::commit();
    }

    fn finalize_exit(engine: &mut Engine, host: &Host) {
        engine.phase = Phase::Hidden;
        engine.xf = Xform::IDENTITY;
        engine.stage = Stage::Idle;
        engine.sink_started = None;
        if engine.passthrough_armed {
            engine.passthrough_armed = false;
            set_passthrough(false);
        }
        reset_webview_layer(host);
        // 完成回调：真正藏窗 + 通知 overlay webview 执行 dismiss 补发等收尾
        if let Some(app) = APP.get() {
            if let Some(window) = app.get_webview_window("overlay") {
                let _ = window.hide();
            }
            let _ = app.emit_to("overlay", "u-words-overlay-exited", ());
        }
    }

    fn set_passthrough(enabled: bool) {
        if let Some(app) = APP.get() {
            if let Some(window) = app.get_webview_window("overlay") {
                let _ = window.set_ignore_cursor_events(enabled);
            }
        }
    }

    // ---------- 对外入口（内部一律 run_on_main_thread，fire-and-forget，禁止等待结果） ----------

    /// setup 钩子调用一次：记录 AppHandle，供起搏回调与引擎收尾使用。
    pub fn mount(app: &AppHandle) {
        let _ = APP.set(app.clone());
        if std::env::var("UWORDS_EFFECTS_TIMING").is_ok() {
            TIMING.store(true, Ordering::Relaxed);
        }
    }

    /// 视图所在屏幕的缩放（backingScaleFactor 在 NSWindow 上；无窗口时按 2 兜底）。
    fn view_scale(view: &NSView) -> f64 {
        view.window()
            .map(|window| window.backingScaleFactor() as f64)
            .unwrap_or(2.0)
    }

    fn enabled(app: &AppHandle) -> bool {
        app.try_state::<EffectsState>()
            .map(|state| state.enabled.load(Ordering::Relaxed))
            .unwrap_or(false)
    }

    fn theme_state(app: &AppHandle) -> u8 {
        app.try_state::<EffectsState>()
            .map(|state| state.theme.load(Ordering::Relaxed))
            .unwrap_or(0)
    }

    fn ensure_native(app: &AppHandle) -> bool {
        if !enabled(app) {
            return false;
        }
        let needs_build = HOST.with_borrow(|slot| slot.is_none());
        if !needs_build {
            return true;
        }
        match build_host(app) {
            Ok(host) => {
                let theme = theme_state(app);
                host.apply_theme(theme);
                HOST.with_borrow_mut(|slot| *slot = Some((Engine::new(), host)));
                true
            }
            Err(error) => {
                eprintln!("原生动效宿主构建失败，回退 webview 路径：{error}");
                false
            }
        }
    }

    fn build_host(app: &AppHandle) -> Result<Host, String> {
        let window = app.get_webview_window("overlay").ok_or("overlay 窗口不存在")?;
        let parent_ptr = window
            .ns_view()
            .map_err(|error| format!("读取 overlay 宿主视图失败：{error}"))?;
        // SAFETY：ns_view 返回容器视图（WryWebViewParent）的借用指针；retain 取一次所有权。
        let parent = unsafe { Retained::retain(parent_ptr as *mut NSView) }.ok_or("overlay 宿主视图为空")?;
        let webview_view = parent.subviews().firstObject().ok_or("overlay webview 子视图缺失")?;

        let bounds = parent.bounds();
        let mtm = MainThreadMarker::new().ok_or("原生动效宿主只能在主线程构建")?;
        let host_view = NSView::initWithFrame(NSView::alloc(mtm), bounds);
        host_view.setWantsLayer(true);
        // layer-backed（而非 layer-hosting）：AppKit 自动把 backing layer 几何同步到视图 bounds。
        // layer-hosting 需要手动管理根层几何——真机实测根层零尺寸导致壳背景“全透明”。
        let root = host_view.layer().ok_or("AppKit 未创建宿主 backing layer")?;
        host_view
            .setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable);
        // 显式置于 WKWebView 之下：webview drawsBackground=false，原生层从透明区域透出
        parent.addSubview_positioned_relativeTo(&host_view, NSWindowOrderingMode::Below, Some(&webview_view));

        let shell_layer = CALayer::layer();
        shell_layer.setMasksToBounds(true);
        shell_layer.setBorderWidth(1.0);
        shell_layer.setHidden(true);
        root.addSublayer(&shell_layer);

        let mut bar_layers = Vec::with_capacity(BAR_COUNT);
        for _ in 0..BAR_COUNT {
            let bar = CALayer::layer();
            bar.setBounds(CGRect::new(
                CGPoint::new(0.0, 0.0),
                CGSize::new(effects_geom::BAR_WIDTH, effects_geom::BAR_BASE),
            ));
            bar.setCornerRadius(5.0);
            bar.setHidden(true);
            root.addSublayer(&bar);
            bar_layers.push(bar);
        }

        let webview_layer = webview_view.layer().ok_or("webview 层缺失")?;
        let scale = view_scale(&host_view);
        root.setContentsScale(scale);
        if TIMING.load(Ordering::Relaxed) {
            eprintln!("[effects-dbg] 宿主构建成功：父视图子视图数={} scale={scale}", parent.subviews().len());
        }
        Ok(Host {
            host_view,
            root_layer: root,
            shell_layer,
            bar_layers,
            webview_layer,
            scale,
        })
    }

    /// show_overlay 在 window.show() 之前调用：壳几何立即落位、全层 opacity 归零（消除首帧竞态）。
    /// 必须在主线程调用（overlay.rs 的 run_on_main 组合闭包内）。
    pub fn prepare_show_now(app: &AppHandle, window_width: f64, window_height: f64) {
        if TIMING.load(Ordering::Relaxed) {
            eprintln!("[effects-dbg] prepare_show_now {window_width}x{window_height} enabled={}", enabled(app));
        }
        if !ensure_native(app) {
            return;
        }
        with_native(|engine, host| {
            engine.shell = effects_geom::shell_for_window(window_width, window_height);
            engine.phase = Phase::Visible;
            engine.xf = Xform { scale: 0.6, y: 14.0, opacity: 0.0 };
            engine.last_tick = None;
            host.apply_theme(theme_state(app));
            CATransaction::begin();
            CATransaction::setDisableActions(true);
            host.shell_layer.setHidden(false);
            apply_frame(engine, host);
            CATransaction::commit();
        });
    }

    /// show_overlay 在 window.show() 之后调用：出场 3 弹簧（~380ms 轻过冲）。必须在主线程调用。
    pub fn begin_enter_now(app: &AppHandle) {
        if TIMING.load(Ordering::Relaxed) {
            eprintln!("[effects-dbg] begin_enter_now reduced={}", reduced_motion());
        }
        if !ensure_native(app) {
            return;
        }
        with_native(|engine, host| {
            engine.exit = None;
            engine.morph = None;
            if reduced_motion() {
                engine.xf = Xform::IDENTITY;
                engine.enter = None;
                apply_frame(engine, host);
                return;
            }
            engine.enter = Some([
                Spring::new(engine.xf.scale, 1.0, SPRING_POP),
                Spring::new(engine.xf.y, 0.0, SPRING_POP),
                Spring::new(engine.xf.opacity, 1.0, SPRING_POP),
            ]);
            engine.last_tick = None;
            ensure_pacer();
            apply_frame(engine, host);
        });
    }

    /// resize_overlay 在窗口尺寸到位后调用：壳 w/h/radius 3 弹簧 + 形变期穿透。必须在主线程调用。
    pub fn begin_morph_now(app: &AppHandle, window_width: f64, window_height: f64) {
        if !ensure_native(app) {
            return;
        }
        with_native(|engine, host| {
            let target = effects_geom::shell_for_window(window_width, window_height);
            if target == engine.shell {
                return;
            }
            engine.morph = Some([
                Spring::new(engine.shell.width, target.width, SPRING_POP),
                Spring::new(engine.shell.height, target.height, SPRING_POP),
                Spring::new(engine.shell.radius, target.radius, SPRING_POP),
            ]);
            engine.last_tick = None;
            if reduced_motion() {
                // 直落终值并立即恢复穿透（与弹簧完成路径同语义）
                engine.shell = target;
                engine.morph = None;
                apply_frame(engine, host);
                return;
            }
            if !engine.passthrough_armed {
                engine.passthrough_armed = true;
                set_passthrough(true);
            }
            ensure_pacer();
        });
    }

    /// OverlayApp 的 resolveStage 变化时调用。record 显示并驱动 bar；process 触发逐根沉降；
    /// 其余隐藏 bar；idle 取消全部动画并隐藏层。必须在主线程调用。
    pub fn set_stage_now(app: &AppHandle, raw: &str) {
        let stage = parse_stage(raw);
        if TIMING.load(Ordering::Relaxed) {
            eprintln!("[effects-dbg] set_stage_now {raw:?}");
        }
        if !ensure_native(app) {
            return;
        }
        with_native(|engine, host| {
            // 退场中被新录音打断：取消退场弹簧（不触发完成回调），保持窗口可见
            if stage == Stage::Record && engine.exit.is_some() {
                engine.exit = None;
            }
            engine.stage = stage;
            host.apply_theme(theme_state(app));
            match stage {
                Stage::Record => {
                    engine.sink_started = None;
                    engine.quiet_frames = 0;
                    for bar in &host.bar_layers {
                        bar.setHidden(false);
                    }
                    engine.last_tick = None;
                    ensure_pacer();
                }
                Stage::Process => {
                    if engine.sink_started.is_none() {
                        engine.sink_started = Some(Instant::now());
                    }
                    engine.last_tick = None;
                    ensure_pacer();
                }
                Stage::Idle => {
                    let restore = engine.cancel_anims();
                    engine.phase = Phase::Hidden;
                    engine.xf = Xform::IDENTITY;
                    reset_webview_layer(host);
                    if restore {
                        set_passthrough(false);
                    }
                }
                Stage::Flash | Stage::Text | Stage::Preview | Stage::Image => {
                    engine.sink_started = None;
                    for bar in &host.bar_layers {
                        bar.setHidden(true);
                    }
                }
            }
            apply_frame(engine, host);
        });
    }

    /// exitAndHide（native 分支）调用：退场 2 弹簧（~160ms 无过冲），完成后真正 hide + emit。
    /// disabled 返回 Err 哨兵，前端走旧路径（直接 hide）。
    pub fn begin_exit(app: &AppHandle) -> Result<(), String> {
        if !enabled(app) {
            return Err("原生动效未启用".into());
        }
        let inner = app.clone();
        let _ = app.run_on_main_thread(move || {
            if !ensure_native(&inner) {
                return;
            }
            with_native(|engine, host| {
                engine.enter = None;
                if reduced_motion() {
                    engine.xf = Xform { scale: 0.85, y: engine.xf.y, opacity: 0.0 };
                    finalize_exit(engine, host);
                    return;
                }
                engine.exit = Some([
                    Spring::new(engine.xf.scale, 0.85, SPRING_SETTLE),
                    Spring::new(engine.xf.opacity, 0.0, SPRING_SETTLE),
                ]);
                engine.last_tick = None;
                ensure_pacer();
                apply_frame(engine, host);
            });
        });
        Ok(())
    }

    /// hide_overlay 直藏路径（取消/兜底）：重置引擎与层，恢复穿透，不发 exited 事件。
    /// 必须在主线程调用。
    pub fn handle_hidden_now(_app: &AppHandle) {
        with_native(|engine, host| {
            let restore = engine.cancel_anims();
            engine.phase = Phase::Hidden;
            engine.stage = Stage::Idle;
            engine.xf = Xform::IDENTITY;
            engine.level_smoothed = 0.0;
            engine.quiet_frames = 0;
            reset_webview_layer(host);
            if restore {
                set_passthrough(false);
            }
        });
    }

    fn reduced_motion() -> bool {
        NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceMotion()
    }

    // ---------- 帧耗打点（UWORDS_EFFECTS_TIMING=1 时启用，dev 观测用） ----------

    thread_local! {
        static TIMING_STATE: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };
    }

    fn record_timing_sample(ms: f64) {
        TIMING_STATE.with_borrow_mut(|samples| {
            samples.push(ms);
            if samples.len() >= 300 {
                samples.sort_by(|a, b| a.total_cmp(b));
                let avg = samples.iter().sum::<f64>() / samples.len() as f64;
                let p99 = samples[(samples.len() as f64 * 0.99) as usize % samples.len()];
                let max = samples[samples.len() - 1];
                eprintln!("[effects-timing] 近 300 帧 tick+写层：avg {avg:.3}ms / p99 {p99:.3}ms / max {max:.3}ms");
                samples.clear();
            }
        });
    }
}

// ---------- 跨平台入口与 Tauri 命令 ----------

#[cfg(target_os = "macos")]
pub use imp::{
    begin_enter_now, begin_exit, begin_morph_now, handle_hidden_now, mount, prepare_show_now,
};

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn effects_set_stage(app: AppHandle, stage: String) -> Result<(), String> {
    if !imp_enabled(&app) {
        return Ok(());
    }
    let inner = app.clone();
    let _ = app.run_on_main_thread(move || imp::set_stage_now(&inner, &stage));
    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn effects_exit_overlay(app: AppHandle) -> Result<(), String> {
    begin_exit(&app)
}

#[cfg(target_os = "macos")]
fn imp_enabled(app: &AppHandle) -> bool {
    use std::sync::atomic::Ordering;
    app.try_state::<crate::EffectsState>()
        .map(|state| state.enabled.load(Ordering::Relaxed))
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn effects_set_stage(_app: AppHandle, _stage: String) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn effects_exit_overlay(_app: AppHandle) -> Result<(), String> {
    Err("原生动效仅支持 macOS".into())
}

#[cfg(not(target_os = "macos"))]
pub fn mount(_app: &AppHandle) {}
#[cfg(not(target_os = "macos"))]
pub fn prepare_show_now(_app: &AppHandle, _width: f64, _height: f64) {}
#[cfg(not(target_os = "macos"))]
pub fn begin_enter_now(_app: &AppHandle) {}
#[cfg(not(target_os = "macos"))]
pub fn begin_morph_now(_app: &AppHandle, _width: f64, _height: f64) {}
#[cfg(not(target_os = "macos"))]
pub fn handle_hidden_now(_app: &AppHandle) {}
