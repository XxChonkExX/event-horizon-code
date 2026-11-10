// Event Horizon Code — Renderer entry (SolidJS)
import { render } from "solid-js/web";
import App from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (root) render(() => <App />, root);
