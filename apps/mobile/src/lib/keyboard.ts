import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Keyboard, Platform, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewInstance } from "react-native";

/** How far to lift a bar that sits at the bottom of a screen so the on-screen keyboard never covers it.
 *
 *  Attach `anchor` to a zero-height, absolutely positioned view at the bottom of the screen. On every keyboard event the anchor's
 *  position in the window is compared with the top of the keyboard, so it is right whether Android resizes the window for the
 *  keyboard (then nothing is covered and the lift is 0) or draws the keyboard over the app (then the bar is lifted by exactly the
 *  overlap). It works the same under any tab bar or safe-area padding because it measures, rather than assumes. */
export function useKeyboardLift() {
  const anchor = useRef<ComponentRef<typeof View>>(null);
  const [lift, setLift] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow", (e) => {
      const top = e.endCoordinates.screenY;
      anchor.current?.measureInWindow((_x, y) => setLift(Math.max(0, Math.round(y - top))));
    });
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setLift(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return { anchor, lift };
}

/** For a long form in a ScrollView: when the keyboard opens it covers the lower half of the screen and (with the window not resized) the field being
 *  typed in can end up underneath it. This pads the end of the content by the keyboard's height, so there is room to scroll, and scrolls just enough
 *  to bring the focused field above the keyboard. Spread `props` on the ScrollView and add `pad` to its bottom padding. */
export function useKeyboardAwareScroll() {
  const ref = useRef<ScrollViewInstance>(null);
  const offset = useRef(0);
  const [pad, setPad] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", (e) => {
      setPad(e.endCoordinates.height);
      const top = e.endCoordinates.screenY;
      // Wait a frame so the extra padding is laid out before scrolling into it.
      setTimeout(() => {
        const input = TextInput.State.currentlyFocusedInput?.();
        input?.measureInWindow((_x, y, _w, h) => {
          const overlap = y + h + 24 - top;
          if (overlap > 0) ref.current?.scrollTo({ y: offset.current + overlap, animated: true });
        });
      }, 60);
    });
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setPad(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const props = {
    ref, scrollEventThrottle: 32,
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => { offset.current = e.nativeEvent.contentOffset.y; },
  };
  return { props, pad };
}
