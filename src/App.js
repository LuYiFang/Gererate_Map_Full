import "./styles.css";
import { useEffect, useRef } from "react";
import _ from "lodash";
import { GenerateMap } from "./generateMap";

export default function App() {
  const canvasRef = useRef();

  useEffect(() => {
    const canvas = canvasRef.current;

    let ctx = canvas.getContext("2d");

    canvas.height = window.innerHeight;
    canvas.width = window.innerWidth;

    const gm = new GenerateMap(ctx, 100, 100, 600, 400, 100, window.innerWidth);
    gm.createMap();
  }, []);

  return (
    <div>
      <canvas id="myCanvas" ref={canvasRef} />
    </div>
  );
}
