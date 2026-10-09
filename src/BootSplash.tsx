import { useLayoutEffect } from "react";
import { holdBootScreen } from "./bootScreen";

export default function BootSplash() {
  useLayoutEffect(holdBootScreen, []);
  return null;
}
