//! Lower only our OCR workers, never the game or the entire app process.

pub(crate) struct GameWorkerPriority {
    // Restoration must happen on the same worker that changed its priority.
    _thread: std::marker::PhantomData<std::rc::Rc<()>>,
    #[cfg(target_os = "windows")]
    previous: Option<i32>,
}

#[cfg(target_os = "windows")]
fn lower_current_thread() -> Option<i32> {
    use windows::Win32::System::Threading::{
        GetCurrentThread, GetThreadPriority, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
    };
    unsafe {
        let thread = GetCurrentThread();
        let previous = GetThreadPriority(thread);
        // Do not raise a thread that was already below normal/idle.
        if previous == i32::MAX || previous <= THREAD_PRIORITY_BELOW_NORMAL.0 {
            return None;
        }
        SetThreadPriority(thread, THREAD_PRIORITY_BELOW_NORMAL)
            .ok()
            .map(|_| previous)
    }
}

impl GameWorkerPriority {
    pub(crate) fn enter() -> Self {
        Self {
            _thread: std::marker::PhantomData,
            #[cfg(target_os = "windows")]
            previous: lower_current_thread(),
        }
    }
}

impl Drop for GameWorkerPriority {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        if let Some(previous) = self.previous {
            use windows::Win32::System::Threading::{
                GetCurrentThread, SetThreadPriority, THREAD_PRIORITY,
            };
            unsafe {
                let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY(previous));
            }
        }
    }
}

/// Private Rayon threads keep this priority for their whole lifetime.
pub(crate) fn prepare_private_thread() {
    #[cfg(target_os = "windows")]
    let _ = lower_current_thread();
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use windows::Win32::System::Threading::{
        GetCurrentThread, GetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
    };

    #[test]
    fn scoped_priority_is_lowered_and_restored_even_during_unwind() {
        let before = unsafe { GetThreadPriority(GetCurrentThread()) };
        let result = std::panic::catch_unwind(|| {
            let _priority = GameWorkerPriority::enter();
            let during = unsafe { GetThreadPriority(GetCurrentThread()) };
            assert!(during <= THREAD_PRIORITY_BELOW_NORMAL.0);
            panic!("synthetic worker failure");
        });
        assert!(result.is_err());
        assert_eq!(unsafe { GetThreadPriority(GetCurrentThread()) }, before);
    }
}
