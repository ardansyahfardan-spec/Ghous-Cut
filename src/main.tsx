import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./style.css";

class AppErrorBoundary extends React.Component<React.PropsWithChildren, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Ghous Cut render error:", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return <main style={{minHeight:"100vh",background:"#090b10",color:"#fff",fontFamily:"system-ui",padding:"32px",boxSizing:"border-box"}}>
        <h1>Ghous Cut mengalami kendala</h1>
        <p>Aplikasi gagal dimuat. Detail error:</p>
        <pre style={{whiteSpace:"pre-wrap",color:"#ff9d9d",background:"#171a24",padding:"16px",borderRadius:"8px"}}>{this.state.error}</pre>
        <p>Coba muat ulang halaman. Jika masih muncul, kirimkan detail error ini.</p>
      </main>;
    }
    return this.props.children;
  }
}

window.addEventListener("error", event => console.error("Ghous Cut window error:", event.error || event.message));
window.addEventListener("unhandledrejection", event => console.error("Ghous Cut async error:", event.reason));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><AppErrorBoundary><App /></AppErrorBoundary></React.StrictMode>
);
