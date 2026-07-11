import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI环球厨房",
  description: "根据家中现有食材，严格匹配全球经典菜与融合创意菜谱。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
