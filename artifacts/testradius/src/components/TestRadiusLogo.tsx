import type { CSSProperties } from "react";

interface TestRadiusLogoProps {
  className?: string;
  height?: number;
}

const BLUE = "#172c79";
const TEAL = "#3daa9a";
const FONT = "'Righteous', 'Trebuchet MS', sans-serif";
const TRACKING = "-0.174em";

export function TestRadiusLogo({
  className = "",
  height = 36,
}: TestSquadLogoProps) {
  const monoSize = height;
  const wordSize = Math.round(height * 0.64);
  const gap = Math.round(height * 0.2);

  const shared: CSSProperties = {
    fontFamily: FONT,
    fontWeight: 700,
    letterSpacing: TRACKING,
    lineHeight: 1,
    display: "inline",
  };

  return (
    <div
      className={className}
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: `${gap}px`,
        userSelect: "none",
      }}
      aria-label="TestRadius"
      role="img"
    >
      <span style={{ ...shared, fontSize: `${monoSize}px` }}>
        <span style={{ color: BLUE }}>t</span>
        <span style={{ color: TEAL }}>R</span>
      </span>

      <span style={{ ...shared, fontSize: `${wordSize}px` }}>
        <span style={{ color: BLUE }}>test</span>
        <span style={{ color: TEAL }}>Radius</span>
      </span>
    </div>
  );
}
