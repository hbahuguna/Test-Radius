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
}: TestRadiusLogoProps) {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <img
        src="/blog-assets/TastRadius-logo-text-2.jpg"
        alt="TestRadius"
        style={{ height: `${Math.round(height * 0.8)}px`, width: 'auto' }}
        className="object-contain"
      />
    </div>
  );
}
