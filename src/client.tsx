import "./styles.css";
import { createRoot } from "react-dom/client";
import App from "./ui/App.js";

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
