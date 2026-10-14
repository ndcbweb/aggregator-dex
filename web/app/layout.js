import "./globals.css";
import Shell from "@/components/Shell";

export const metadata = {
  title: "Swap",
  description: "Swap at the best price across every DEX",
};

const themeBoot = `try{var t=localStorage.getItem("agg-theme");var d=t?t==="dark":true;document.documentElement.classList.toggle("dark",d)}catch(e){}`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
      </head>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
