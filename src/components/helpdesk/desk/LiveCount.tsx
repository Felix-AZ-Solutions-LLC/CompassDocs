"use client";

// A count on the desk's rails that changes live (1.20.19): when the number
// changes it rolls in from below (up) or above (down) and pulses the accent
// for a moment (`hd-live-count`, globals.css). The first number shown, and
// any number under reduced motion, simply appears.

import { useEffect, useRef } from "react";

export function LiveCount({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(value);
  useEffect(() => {
    const was = prev.current;
    prev.current = value;
    const el = ref.current;
    if (!el || was === value) return;
    delete el.dataset.bump;
    void el.offsetWidth; // restart the animation when it is already running
    el.dataset.bump = value > was ? "up" : "down";
    const t = setTimeout(() => {
      delete el.dataset.bump;
    }, 1_300);
    return () => clearTimeout(t);
  }, [value]);
  return (
    <span ref={ref} className="hd-live-count" data-live-count="">
      {value}
    </span>
  );
}
