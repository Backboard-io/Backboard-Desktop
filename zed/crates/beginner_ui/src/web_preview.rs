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
        match &mut self.inner {
            #[cfg(target_os = "macos")]
            Inner::Macos(inner) => inner.load_url(url),
            #[cfg(target_os = "windows")]
            Inner::Windows(inner) => inner.load_url(url),
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
    use std::ffi::CString;
    use std::ptr::NonNull;

    use cocoa::base::{id, nil};
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

        /// Coordinate conventions:
        ///   GPUI element bounds — origin is top-left of the window (logical px)
        ///   NSView frames      — origin is bottom-left of the view  (points)
        ///
        ///   Conversion: ns_y = viewport_height − gpui_y − element_height
        pub fn set_frame(&self, bounds: Bounds<Pixels>, viewport_height: f32) {
            let x: f64 = f32::from(bounds.origin.x) as f64;
            let h: f64 = f32::from(bounds.size.height) as f64;
            let y: f64 = (viewport_height as f64) - f32::from(bounds.origin.y) as f64 - h;
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

    /// Get the NSView to use as parent for the WKWebView.
    ///
    /// GPUI's AppKitWindowHandle wraps the Metal-backed GPUIView. We climb one
    /// level to its superview (the window's contentView) so the WKWebView is a
    /// sibling of the Metal layer rather than a child of it.
    fn get_content_view(window: &Window) -> Option<id> {
        let handle = <Window as raw_window_handle::HasWindowHandle>::window_handle(window).ok()?;
        let ns_view = match handle.as_raw() {
            RawWindowHandle::AppKit(h) => h.ns_view.as_ptr() as id,
            _ => return None,
        };
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
