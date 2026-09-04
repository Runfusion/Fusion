export interface MobileBarKeyboardFlagsInput {
  isMobile: boolean;
  keyboardOpen: boolean;
  keyboardFocusPending: boolean;
  anyModalOpen: boolean;
  /** True when a fullscreen mobile overlay owns keyboard/viewport layout. */
  overlayOpen: boolean;
}

export interface MobileBarKeyboardFlags {
  footerHidden: boolean;
  navKeyboardOpen: boolean;
  footerKeyboardOpen: boolean;
}

/*
FNXC:MobileChatKeyboardLayout 2026-06-26-09:04:
While the soft keyboard is up on mobile, the dashboard must NOT show the executor footer (task counts / Running indicator) and must NOT leave dead space above the keyboard. `footerHidden` drives both: it returns the ExecutorStatusBar null AND drops `.project-content`'s reserved footer+nav padding-bottom, letting the composer sit directly above the keyboard.

This now applies to BOTH iOS and Android. Previously `footerHidden` was iOS-only (FN-5707): on Android `interactive-widget=resizes-content` shrinks the layout viewport, so the footer's stacked bottom position was technically "correct" — but with the nav bar slid off-screen (`translateY(100%)`) on keyboard-open, its reserved ~80px (footer-height + nav-height) padding rendered as an empty gap between the footer and the keyboard, with the footer still visible. Matching iOS removes both the footer and the gap on Android.

FN-5707's original Android concern (stripping nav padding mid-focus could make Android Chrome treat the focused input as moving and dismiss the keyboard) is mitigated because the strip is keyed off `keyboardOpen`, which only flips true AFTER the visualViewport has settled into its keyboard-open size — not during the focus transition.

FNXC:MobileChatKeyboardLayout 2026-09-01-05:36:
The footer bottom reservation is only correct while the nav bar is on screen. Use the nav bar's unsettled-tolerant trigger for the footer collapse on both platforms; otherwise a rendered footer rises with an empty mobile-nav-height and safe-area band beneath it.

Fullscreen mobile overlays (for example Quick Chat's sheet) own their own visual viewport handling. Treat them like modals for board-layout padding so overlay-local keyboards never shift the underlying board.
*/
export function computeMobileBarKeyboardFlags({
  isMobile,
  keyboardOpen,
  keyboardFocusPending,
  anyModalOpen,
  overlayOpen,
}: MobileBarKeyboardFlagsInput): MobileBarKeyboardFlags {
  /*
  FNXC:MobileChatKeyboardLayout 2026-08-23-18:14:
  The nav bar's off-screen slide must not wait for a settled visualViewport sample: a withheld or late metric previously left it visible and lifted on individual keyboard opens. The padding strip and iOS footer collapse stay settled-gated because FN-5707 constrained them.
  */
  const boardLayoutSuppressed = anyModalOpen || overlayOpen;
  const footerHidden = isMobile && keyboardOpen && !boardLayoutSuppressed;
  const navKeyboardOpen = isMobile && (keyboardOpen || keyboardFocusPending);
  const footerKeyboardOpen = isMobile && (keyboardOpen || keyboardFocusPending);

  return {
    footerHidden,
    navKeyboardOpen,
    footerKeyboardOpen,
  };
}
