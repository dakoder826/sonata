"use client";

import { useEffect, useState } from "react";

const SEGMENTS = [
  { text: "Convert any song link into ", accent: false },
  { text: "clean piano sheets", accent: true },
  { text: ".", accent: false },
];

const FULL_LEN = SEGMENTS.reduce((n, s) => n + s.text.length, 0);
const MS_PER_CHAR = 36;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return reduced;
}

export default function TypewriterHeadline({ className = "" }) {
  const reducedMotion = usePrefersReducedMotion();
  const [len, setLen] = useState(() => {
    if (typeof window === "undefined") return 0;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? FULL_LEN
      : 0;
  });

  useEffect(() => {
    if (reducedMotion) {
      setLen(FULL_LEN);
    }
  }, [reducedMotion]);

  useEffect(() => {
    if (reducedMotion) return undefined;
    if (len >= FULL_LEN) return undefined;
    const id = window.setTimeout(() => setLen((c) => c + 1), MS_PER_CHAR);
    return () => window.clearTimeout(id);
  }, [len, reducedMotion]);

  let remaining = len;
  const nodes = [];

  SEGMENTS.forEach((seg, i) => {
    const take = Math.min(remaining, seg.text.length);
    remaining -= take;
    if (take <= 0) return;
    const chunk = seg.text.slice(0, take);
    if (seg.accent) {
      nodes.push(
        <span
          key={i}
          className="rounded-md bg-white px-2 py-0.5 font-semibold text-neutral-950 shadow-[0_1px_0_rgba(0,0,0,0.06)] [box-decoration-break:clone]"
        >
          {chunk}
        </span>
      );
    } else {
      nodes.push(<span key={i}>{chunk}</span>);
    }
  });

  return (
    <h1
      className={`font-semibold tracking-tight text-neutral-100 ${className}`}
    >
      {nodes}
      <span
        className="typewriter-caret ml-0.5 inline-block h-[0.92em] w-[2px] translate-y-px align-[-0.12em] bg-white shadow-[0_0_6px_rgba(255,255,255,0.5)]"
        aria-hidden
      />
    </h1>
  );
}
