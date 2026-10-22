import { useEffect, useState } from "react";

// 全局共享一个 IntersectionObserver 实例
// 避免每张卡片各自创建 observer，首页/列表页几十张卡片时开销明显
type Callback = (isInView: boolean) => void;

let sharedObserver: IntersectionObserver | null = null;
const callbackMap = new WeakMap<Element, Callback>();

function getObserver(): IntersectionObserver {
  if (sharedObserver) return sharedObserver;

  sharedObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const cb = callbackMap.get(entry.target);
        if (cb) cb(entry.isIntersecting);
      });
    },
    {
      // 比可视区再扩 200px，让靠近视口的卡片也允许预览
      rootMargin: "200px 0px",
      threshold: 0,
    }
  );

  return sharedObserver;
}

export function useInViewport(
  ref: React.RefObject<Element | null>,
  enabled = true
): boolean {
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;

    const obs = getObserver();
    callbackMap.set(el, setInView);
    obs.observe(el);

    return () => {
      obs.unobserve(el);
      callbackMap.delete(el);
    };
  }, [ref, enabled]);

  return inView;
}
