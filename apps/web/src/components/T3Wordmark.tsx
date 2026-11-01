import { useId, type SVGProps } from "react";

// Fork: a sheep from Flock's app icon, in place of upstream's T3 mark.
// One colour: the wool is solid, and the face and legs are dimmed, with the face cut out of the wool.
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  const faceCutout = useId();
  return (
    <svg {...props} viewBox="-11 -8.6 23.8 18" xmlns="http://www.w3.org/2000/svg">
      <mask id={faceCutout}>
        {/* oxlint-disable-next-line shadcn/no-raw-colors -- mask luminance: white keeps, it is never painted */}
        <rect x="-11" y="-8.6" width="23.8" height="18" fill="#fff" />
        <ellipse cx="9.2" cy="-1.8" rx="3.7" ry="4.3" transform="rotate(22 9.2 -1.8)" />
        <ellipse cx="7.2" cy="-4" rx="2.7" ry="1.6" transform="rotate(-30 7.2 -4)" />
      </mask>
      <g fill="currentColor">
        <g opacity="0.55">
          <rect x="-6.25" y="3" width="1.5" height="6.2" rx="0.7" />
          <rect x="-2.95" y="3" width="1.5" height="6.2" rx="0.7" />
          <rect x="1.45" y="3" width="1.5" height="6.2" rx="0.7" />
          <rect x="4.75" y="3" width="1.5" height="6.2" rx="0.7" />
        </g>
        <g mask={`url(#${faceCutout})`}>
          <ellipse cx="0" cy="0" rx="8.74" ry="5.7" />
          <circle cx="0" cy="-4.84" r="3.6" />
          <circle cx="5.79" cy="-3.02" r="3.6" />
          <circle cx="7.22" cy="1.08" r="3.6" />
          <circle cx="3.22" cy="4.36" r="3.6" />
          <circle cx="-3.22" cy="4.36" r="3.6" />
          <circle cx="-7.22" cy="1.08" r="3.6" />
          <circle cx="-5.79" cy="-3.02" r="3.6" />
        </g>
        <g opacity="0.55">
          <ellipse cx="7.2" cy="-4" rx="2" ry="0.9" transform="rotate(-30 7.2 -4)" />
          <ellipse cx="9.2" cy="-1.8" rx="3" ry="3.6" transform="rotate(22 9.2 -1.8)" />
        </g>
        <circle cx="10.2" cy="-2.2" r="0.6" />
      </g>
    </svg>
  );
}
