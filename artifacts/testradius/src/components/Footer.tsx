import React from "react";
import { Link } from "wouter";
import { TestRadiusLogo } from "@/components/TestRadiusLogo";

export function Footer() {
  return (
    <footer className="bg-background border-t border-border py-12">
      <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-6">
        <TestRadiusLogo height={28} />

        <div className="text-sm text-muted-foreground">
          &copy; 2025 TestRadius. All rights reserved.
        </div>

        <div className="flex gap-6 text-sm font-medium text-muted-foreground items-center">
          <Link href="/jobs" className="hover:text-primary transition-colors">
            Careers
          </Link>
          <a
            href="mailto:hello@testradius.dev"
            className="hover:text-primary transition-colors"
          >
            Contact
          </a>
          <a
            href="https://zcal.co/i/suLjJzcq"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-primary transition-colors"
          >
            Schedule a meeting
          </a>
        </div>
      </div>
    </footer>
  );
}
