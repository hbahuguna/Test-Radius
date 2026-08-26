import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, type Browser } from "playwright";
import { renderReportHtml } from "./template.js";
import type { TestSuiteReport } from "./types.js";

let sharedBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  sharedBrowser = await chromium.launch({ headless: true });
  return sharedBrowser;
}

async function htmlToPdfBuffer(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const buffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
    });
    await page.close();
    return Buffer.from(buffer);
  } finally {
    await browser.close();
    sharedBrowser = null;
  }
}

export async function generatePdfFromHtml(html: string, outputPath: string): Promise<string> {
  mkdirSync(dirname(outputPath), { recursive: true });
  const browser = await getBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.pdf({
      path: outputPath,
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
    });
    await page.close();
  } finally {
    await browser.close();
    sharedBrowser = null;
  }
  return outputPath;
}

export async function generatePdf(report: TestSuiteReport, outputPath: string): Promise<string> {
  const html = renderReportHtml(report);
  return generatePdfFromHtml(html, outputPath);
}

export async function generatePdfToBuffer(report: TestSuiteReport): Promise<Buffer> {
  const html = renderReportHtml(report);
  return htmlToPdfBuffer(html);
}
