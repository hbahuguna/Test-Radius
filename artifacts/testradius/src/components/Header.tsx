import React from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { TestRadiusLogo } from "@/components/TestRadiusLogo";

interface HeaderProps {
  scrollToForm: () => void;
}

export function Header({ scrollToForm }: HeaderProps) {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-md border-b border-border/40">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/">
          <TestRadiusLogo height={32} />
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/docs">
            <Button variant="ghost" className="hidden sm:inline-flex">
              Docs
            </Button>
          </Link>
          <Link href="/blog">
            <Button variant="ghost" className="hidden sm:inline-flex">
              Blog
            </Button>
          </Link>
          <Link href="/jobs">
            <Button variant="ghost" className="hidden sm:inline-flex">
              Careers
            </Button>
          </Link>
          <Button
            variant="ghost"
            className="hidden sm:inline-flex"
            onClick={scrollToForm}
          >
            Join Pilot
          </Button>
          <Button
            onClick={scrollToForm}
            className="font-medium shadow-sm hover:shadow-md transition-all"
          >
            Get Early Access
          </Button>
        </div>
      </div>
    </nav>
  );
}
