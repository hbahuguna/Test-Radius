interface TestSquadLogoProps {
  className?: string;
  height?: number;
}

export function TestSquadLogo({ className = "", height = 36 }: TestSquadLogoProps) {
  const indigo = "hsl(250, 84%, 54%)";
  const teal = "hsl(172, 58%, 52%)";
  const white = "#ffffff";

  const aspect = 148 / 36;
  const width = height * aspect;

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 148 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="TestSquad"
    >
      {/* Icon mark — two overlapping rounded rectangles forming a TS monogram */}

      {/* T block — indigo, left-aligned */}
      <rect x="0" y="0" width="22" height="22" rx="5" fill={indigo} />
      {/* Horizontal bar of T */}
      <rect x="3" y="4" width="16" height="4" rx="1.5" fill={white} />
      {/* Vertical stem of T */}
      <rect x="9" y="4" width="4" height="15" rx="1.5" fill={white} />

      {/* S block — teal, offset right+down to overlap */}
      <rect x="12" y="14" width="22" height="22" rx="5" fill={teal} />
      {/* S path drawn as SVG path inside the teal block */}
      {/* Upper curve of S */}
      <path
        d="M22 19.5 C22 18.12 23.12 17 24.5 17 H29 C30.38 17 31.5 18.12 31.5 19.5 C31.5 20.88 30.38 22 29 22 H25 C23.62 22 22.5 23.12 22.5 24.5 C22.5 25.88 23.62 27 25 27 H29.5 C30.88 27 32 28.12 32 29.5"
        stroke={white}
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />

      {/* Wordmark — "test" in indigo, "Squad" in teal */}
      <text
        x="40"
        y="26"
        fontFamily="Inter, -apple-system, BlinkMacSystemFont, sans-serif"
        fontWeight="700"
        fontSize="18"
        letterSpacing="-0.5"
        fill={indigo}
      >
        test
      </text>
      <text
        x="88"
        y="26"
        fontFamily="Inter, -apple-system, BlinkMacSystemFont, sans-serif"
        fontWeight="700"
        fontSize="18"
        letterSpacing="-0.5"
        fill={teal}
      >
        Squad
      </text>
    </svg>
  );
}
