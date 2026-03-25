"use client";

/**
 * Decorative musical symbols drifting behind page content (pointer-events none).
 * Uses fixed positions so notes appear across the full scroll / viewport.
 */

const SYMBOLS = ["♪", "♫", "♬", "♩", "♭", "♮"];

const NOTES = [
  { sym: 0, left: "3%", top: "6%", size: "text-3xl", key: "a", dur: 22, delay: 0 },
  { sym: 1, left: "14%", top: "18%", size: "text-4xl", key: "b", dur: 28, delay: -4 },
  { sym: 2, left: "88%", top: "8%", size: "text-2xl", key: "c", dur: 24, delay: -2 },
  { sym: 3, left: "72%", top: "22%", size: "text-3xl", key: "a", dur: 26, delay: -8 },
  { sym: 4, left: "8%", top: "38%", size: "text-xl", key: "d", dur: 30, delay: -6 },
  { sym: 5, left: "52%", top: "12%", size: "text-4xl", key: "c", dur: 21, delay: -1 },
  { sym: 0, left: "94%", top: "35%", size: "text-2xl", key: "b", dur: 25, delay: -9 },
  { sym: 2, left: "22%", top: "52%", size: "text-3xl", key: "a", dur: 27, delay: -3 },
  { sym: 1, left: "65%", top: "45%", size: "text-xl", key: "d", dur: 23, delay: -11 },
  { sym: 3, left: "40%", top: "58%", size: "text-4xl", key: "b", dur: 29, delay: -5 },
  { sym: 4, left: "82%", top: "55%", size: "text-2xl", key: "c", dur: 24, delay: -7 },
  { sym: 5, left: "6%", top: "68%", size: "text-3xl", key: "a", dur: 26, delay: -10 },
  { sym: 0, left: "58%", top: "72%", size: "text-3xl", key: "d", dur: 31, delay: -2 },
  { sym: 2, left: "30%", top: "78%", size: "text-xl", key: "b", dur: 22, delay: -12 },
  { sym: 1, left: "76%", top: "82%", size: "text-2xl", key: "c", dur: 28, delay: -4 },
  { sym: 4, left: "48%", top: "88%", size: "text-3xl", key: "a", dur: 25, delay: -8 },
  { sym: 3, left: "92%", top: "68%", size: "text-4xl", key: "d", dur: 27, delay: -6 },
  { sym: 5, left: "18%", top: "92%", size: "text-xl", key: "b", dur: 24, delay: -1 },
  { sym: 1, left: "38%", top: "28%", size: "text-2xl", key: "c", dur: 32, delay: -14 },
  { sym: 0, left: "62%", top: "36%", size: "text-3xl", key: "a", dur: 20, delay: -3 },
  { sym: 2, left: "12%", top: "82%", size: "text-4xl", key: "d", dur: 26, delay: -9 },
  { sym: 4, left: "85%", top: "48%", size: "text-xl", key: "b", dur: 29, delay: -5 },
  { sym: 3, left: "45%", top: "5%", size: "text-2xl", key: "c", dur: 23, delay: -13 },
  { sym: 5, left: "55%", top: "92%", size: "text-3xl", key: "a", dur: 27, delay: -7 },
  { sym: 2, left: "26%", top: "62%", size: "text-2xl", key: "d", dur: 25, delay: -2 },
  { sym: 1, left: "68%", top: "8%", size: "text-xl", key: "b", dur: 30, delay: -10 },
  { sym: 3, left: "50%", top: "42%", size: "text-2xl", key: "c", dur: 33, delay: -15 },
  { sym: 0, left: "96%", top: "92%", size: "text-3xl", key: "a", dur: 24, delay: -4 },
  { sym: 5, left: "1%", top: "48%", size: "text-xl", key: "d", dur: 28, delay: -11 },
  { sym: 2, left: "42%", top: "96%", size: "text-2xl", key: "b", dur: 26, delay: -6 },
  { sym: 4, left: "78%", top: "28%", size: "text-3xl", key: "c", dur: 31, delay: -9 },
  { sym: 1, left: "34%", top: "8%", size: "text-xl", key: "a", dur: 22, delay: -3 },
  { sym: 3, left: "60%", top: "62%", size: "text-4xl", key: "d", dur: 27, delay: -12 },
];

const keyframeName = {
  a: "sonata-float-a",
  b: "sonata-float-b",
  c: "sonata-float-c",
  d: "sonata-float-d",
};

export default function FloatingNotes() {
  return (
    <div
      className="floating-notes-layer pointer-events-none fixed inset-0 z-[1] overflow-hidden"
      aria-hidden
    >
      {NOTES.map((n, i) => (
        <span
          key={i}
          className={`floating-note absolute select-none ${n.size}`}
          style={{
            left: n.left,
            top: n.top,
            // Full shorthand so delay is not lost; name duration easing delay iteration
            animation: `${keyframeName[n.key]} ${n.dur}s ease-in-out ${n.delay}s infinite`,
          }}
        >
          {SYMBOLS[n.sym]}
        </span>
      ))}
    </div>
  );
}
