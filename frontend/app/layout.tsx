import "./globals.css";
import { Providers } from "./providers";
import { FlowShell } from "@/components/flow-shell";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "MyOffer · 把 Offer 摆上桌，算清楚再签",
  description:
    "MyOffer：把 2–3 份 Offer 摆上桌，结合你的偏好看清哪份更适合你、为什么，以及还该确认什么。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>
          <FlowShell>{children}</FlowShell>
        </Providers>
      </body>
    </html>
  );
}
