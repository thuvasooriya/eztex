/* @refresh reload */
import { render } from "solid-js/web";
import "./index.css";
import App from "./App";
import { register_pwa_updates } from "./pwa_update";

const root = document.getElementById("root");
register_pwa_updates();
render(() => <App />, root!);
