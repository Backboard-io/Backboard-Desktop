/// Embedded web preview pane.
///
/// Platform support:
///   macOS   — native WKWebView added as a sibling of GPUI's Metal layer
///   Windows — WebView2 child window via wry
///   Linux   — not embedded; returns None so the caller shows "Open in Browser"
///
/// All implementations share the same public API so callers are platform-agnostic.
use gpui::{Bounds, Pixels, Window};

pub struct WebPreview {
    inner: Inner,
}

enum Inner {
    #[cfg(target_os = "macos")]
    Macos(macos::WebPreviewInner),
    #[cfg(target_os = "windows")]
    Windows(windows::WebPreviewInner),
    #[allow(dead_code)]
    Unsupported,
}

// Only accessed from GPUI's main thread.
unsafe impl Send for WebPreview {}
unsafe impl Sync for WebPreview {}

impl WebPreview {
    /// Create and embed a web preview. Returns `None` when the platform does not
    /// support embedded child web views (currently Linux/Wayland).
    pub fn new(window: &Window, url: &str) -> Option<Self> {
        #[cfg(target_os = "macos")]
        {
            let inner = macos::WebPreviewInner::new(window, url)?;
            return Some(WebPreview {
                inner: Inner::Macos(inner),
            });
        }
        #[cfg(target_os = "windows")]
        {
            let inner = windows::WebPreviewInner::new(window, url)?;
            return Some(WebPreview {
                inner: Inner::Windows(inner),
            });
        }
        #[allow(unreachable_code)]
        let _ = (window, url);
        None
    }

    /// Navigate to a new URL. No-op when URL is unchanged.
    pub fn load_url(&mut self, url: &str) {
        if self.current_url().as_deref() == Some(url) {
            return;
        }
        match &mut self.inner {
            #[cfg(target_os = "macos")]
            Inner::Macos(inner) => inner.load_url(url),
            #[cfg(target_os = "windows")]
            Inner::Windows(inner) => inner.load_url(url),
            Inner::Unsupported => {}
        }
    }

    pub fn current_url(&self) -> Option<String> {
        match &self.inner {
            #[cfg(target_os = "macos")]
            Inner::Macos(inner) => inner.current_url(),
            #[cfg(target_os = "windows")]
            Inner::Windows(inner) => inner.current_url(),
            Inner::Unsupported => None,
        }
    }

    pub fn release_focus(&self, window: &Window) {
        let _ = window;
        match &self.inner {
            #[cfg(target_os = "macos")]
            Inner::Macos(inner) => inner.release_focus(window),
            #[cfg(target_os = "windows")]
            Inner::Windows(inner) => inner.release_focus(),
            Inner::Unsupported => {}
        }
    }

    pub fn reload(&self) {
        match &self.inner {
            #[cfg(target_os = "macos")]
            Inner::Macos(inner) => inner.reload(),
            #[cfg(target_os = "windows")]
            Inner::Windows(inner) => inner.reload(),
            Inner::Unsupported => {}
        }
    }

    pub fn stop_loading(&self) {
        match &self.inner {
            #[cfg(target_os = "macos")]
            Inner::Macos(inner) => inner.stop_loading(),
            #[cfg(target_os = "windows")]
            Inner::Windows(inner) => inner.stop_loading(),
            Inner::Unsupported => {}
        }
    }

    pub fn go_back(&self) {
        match &self.inner {
            #[cfg(target_os = "macos")]
            Inner::Macos(inner) => inner.go_back(),
            #[cfg(target_os = "windows")]
            Inner::Windows(inner) => inner.go_back(),
            Inner::Unsupported => {}
        }
    }

    pub fn go_forward(&self) {
        match &self.inner {
            #[cfg(target_os = "macos")]
            Inner::Macos(inner) => inner.go_forward(),
            #[cfg(target_os = "windows")]
            Inner::Windows(inner) => inner.go_forward(),
            Inner::Unsupported => {}
        }
    }

    /// Reposition and resize the embedded view to match GPUI element `bounds`
    /// (logical pixels, top-left origin of the window).
    pub fn set_frame(&self, bounds: Bounds<Pixels>, viewport_height: f32) {
        match &self.inner {
            #[cfg(target_os = "macos")]
            Inner::Macos(inner) => inner.set_frame(bounds, viewport_height),
            #[cfg(target_os = "windows")]
            Inner::Windows(inner) => inner.set_frame(bounds),
            Inner::Unsupported => {}
        }
    }
}

// ── macOS ─────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{CStr, CString};
    use std::os::raw::c_char;
    use std::ptr::NonNull;

    use cocoa::base::{BOOL, id, nil};
    use cocoa::foundation::{NSPoint, NSRect, NSSize};
    use gpui::{Bounds, Pixels, Window};
    use objc::{class, msg_send, runtime::Object, sel, sel_impl};
    use raw_window_handle::RawWindowHandle;

    pub struct WebPreviewInner {
        webview: NonNull<Object>,
        current_url: String,
    }

    impl WebPreviewInner {
        /// Create a WKWebView as a sibling of GPUI's Metal layer (child of contentView).
        pub fn new(window: &Window, url: &str) -> Option<Self> {
            let parent = get_content_view(window)?;
            unsafe { create(parent, url) }
        }

        pub fn load_url(&mut self, url: &str) {
            if url == self.current_url {
                return;
            }
            unsafe { load_url_on_view(self.webview.as_ptr() as id, url) }
            self.current_url = url.to_string();
        }

        pub fn current_url(&self) -> Option<String> {
            unsafe {
                let url: id = msg_send![self.webview.as_ptr(), URL];
                if url == nil {
                    return Some(self.current_url.clone());
                }
                let absolute_string: id = msg_send![url, absoluteString];
                if absolute_string == nil {
                    return Some(self.current_url.clone());
                }
                let bytes: *const c_char = msg_send![absolute_string, UTF8String];
                if bytes.is_null() {
                    return Some(self.current_url.clone());
                }
                CStr::from_ptr(bytes)
                    .to_str()
                    .ok()
                    .filter(|url| !url.is_empty())
                    .map(ToOwned::to_owned)
                    .or_else(|| Some(self.current_url.clone()))
            }
        }

        pub fn release_focus(&self, window: &Window) {
            let Some(gpui_view) = get_gpui_view(window) else {
                return;
            };
            unsafe {
                let _: BOOL = msg_send![self.webview.as_ptr(), resignFirstResponder];
                let ns_window: id = msg_send![gpui_view, window];
                if ns_window != nil {
                    let _: () = msg_send![ns_window, endEditingFor: nil];
                    let _: BOOL = msg_send![ns_window, makeFirstResponder: nil];
                    let _: BOOL = msg_send![ns_window, makeFirstResponder: gpui_view];
                }
            }
        }

        pub fn reload(&self) {
            unsafe {
                let _: () = msg_send![self.webview.as_ptr(), reload];
            }
        }

        pub fn stop_loading(&self) {
            unsafe {
                let _: () = msg_send![self.webview.as_ptr(), stopLoading];
            }
        }

        pub fn go_back(&self) {
            unsafe {
                let _: () = msg_send![self.webview.as_ptr(), goBack];
            }
        }

        pub fn go_forward(&self) {
            unsafe {
                let _: () = msg_send![self.webview.as_ptr(), goForward];
            }
        }

        /// Coordinate conventions:
        ///   GPUI element bounds — origin is top-left of the window (logical px)
        ///   NSView frames      — origin is bottom-left of the view  (points)
        ///
        ///   Conversion: ns_y = parent_height − gpui_y − element_height
        pub fn set_frame(&self, bounds: Bounds<Pixels>, viewport_height: f32) {
            let x: f64 = f32::from(bounds.origin.x) as f64;
            let h: f64 = f32::from(bounds.size.height) as f64;
            let parent_height = unsafe {
                let parent: id = msg_send![self.webview.as_ptr(), superview];
                if parent == nil {
                    viewport_height as f64
                } else {
                    let parent_bounds: NSRect = msg_send![parent, bounds];
                    parent_bounds.size.height
                }
            };
            let y: f64 = parent_height - f32::from(bounds.origin.y) as f64 - h;
            let w: f64 = f32::from(bounds.size.width) as f64;
            let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(w, h));
            unsafe {
                let _: () = msg_send![self.webview.as_ptr(), setFrame: frame];
            }
        }
    }

    impl Drop for WebPreviewInner {
        fn drop(&mut self) {
            unsafe {
                let _: () = msg_send![self.webview.as_ptr(), removeFromSuperview];
                let _: () = msg_send![self.webview.as_ptr(), release];
            }
        }
    }

    fn get_gpui_view(window: &Window) -> Option<id> {
        let handle = <Window as raw_window_handle::HasWindowHandle>::window_handle(window).ok()?;
        match handle.as_raw() {
            RawWindowHandle::AppKit(h) => Some(h.ns_view.as_ptr() as id),
            _ => None,
        }
    }

    /// Get the NSView to use as parent for the WKWebView.
    ///
    /// GPUI's AppKitWindowHandle wraps the Metal-backed GPUIView. We climb one
    /// level to its superview (the window's contentView) so the WKWebView is a
    /// sibling of the Metal layer rather than a child of it.
    fn get_content_view(window: &Window) -> Option<id> {
        let ns_view = get_gpui_view(window)?;
        unsafe {
            let parent: id = msg_send![ns_view, superview];
            if parent == nil {
                Some(ns_view)
            } else {
                Some(parent)
            }
        }
    }

    unsafe fn create(parent: id, url: &str) -> Option<WebPreviewInner> {
        let config: id = unsafe { msg_send![class!(WKWebViewConfiguration), new] };

        let zero = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));
        let wv: id = unsafe { msg_send![class!(WKWebView), alloc] };
        let wv: id = unsafe { msg_send![wv, initWithFrame: zero configuration: config] };
        if wv == nil {
            return None;
        }

        unsafe {
            let _: () = msg_send![wv, retain];
        }
        unsafe {
            let _: () = msg_send![parent, addSubview: wv];
        }
        unsafe {
            let _: () = msg_send![wv, release];
        }

        unsafe { load_url_on_view(wv, url) };

        Some(WebPreviewInner {
            webview: NonNull::new(wv as *mut Object)?,
            current_url: url.to_string(),
        })
    }

    unsafe fn load_url_on_view(wv: id, url: &str) {
        let Ok(cstr) = CString::new(url) else { return };
        let url_str: id =
            unsafe { msg_send![class!(NSString), stringWithUTF8String: cstr.as_ptr()] };
        let nsurl: id = unsafe { msg_send![class!(NSURL), URLWithString: url_str] };
        let request: id = unsafe { msg_send![class!(NSURLRequest), requestWithURL: nsurl] };
        unsafe {
            let _: () = msg_send![wv, loadRequest: request];
        }
    }
}

// ── Windows ───────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod windows {
    use gpui::{Bounds, Pixels, Window};
    use wry::{WebView, WebViewBuilder};

    pub struct WebPreviewInner {
        webview: WebView,
        current_url: String,
    }

    impl WebPreviewInner {
        pub fn new(window: &Window, url: &str) -> Option<Self> {
            let webview = WebViewBuilder::new()
                .with_url(url)
                .with_accept_first_mouse(true)
                .build_as_child(window)
                .ok()?;
            Some(Self {
                webview,
                current_url: url.to_string(),
            })
        }

        pub fn load_url(&mut self, url: &str) {
            if url == self.current_url {
                return;
            }
            self.webview.load_url(url).ok();
            self.current_url = url.to_string();
        }

        pub fn current_url(&self) -> Option<String> {
            Some(self.current_url.clone())
        }

        pub fn release_focus(&self) {
            self.webview
                .evaluate_script(
                    "if (document.activeElement) document.activeElement.blur(); window.blur();",
                )
                .ok();
        }

        pub fn reload(&self) {
            self.webview
                .evaluate_script("window.location.reload()")
                .ok();
        }

        pub fn stop_loading(&self) {
            self.webview.evaluate_script("window.stop()").ok();
        }

        pub fn go_back(&self) {
            self.webview.evaluate_script("history.back()").ok();
        }

        pub fn go_forward(&self) {
            self.webview.evaluate_script("history.forward()").ok();
        }

        /// wry uses top-left logical coordinates relative to the parent window,
        /// matching GPUI's coordinate system directly.
        pub fn set_frame(&self, bounds: Bounds<Pixels>) {
            use wry::dpi::{LogicalPosition, LogicalSize, Position, Size};
            let rect = wry::Rect {
                position: Position::Logical(LogicalPosition::new(
                    f64::from(f32::from(bounds.origin.x)),
                    f64::from(f32::from(bounds.origin.y)),
                )),
                size: Size::Logical(LogicalSize::new(
                    f64::from(f32::from(bounds.size.width)),
                    f64::from(f32::from(bounds.size.height)),
                )),
            };
            self.webview.set_bounds(rect).ok();
        }
    }
}
