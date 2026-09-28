import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./app/App.js";
import { ThemeProvider } from "./ui/theme.js";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) throw new Error("index.html is missing its #root element");

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
