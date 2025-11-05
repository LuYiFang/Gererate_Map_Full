import { voronoi } from "d3-voronoi";
import * as d3 from "d3";
import _ from "lodash";
import PoissonDiskSampling from "poisson-disk-sampling";

const colors = [
  "#41E0A2",
  "#E0CF5F",
  "#CD37E0",
  "#4B4861",
  "#2F5F34",
  "#664733",
  "#99DB2C",
  "#F3DA9D",
  "#E05151",
  "#5570A6",
];

const ISLAND_FACTOR = 1;

export class GenerateMap {
  constructor(ctx, x0, y0, width, height, n, canvasWidth) {
    this.ctx = ctx;
    this.voronoi = new voronoi().extent([
      [x0, y0],
      [x0 + width, y0 + height],
    ]);

    this.width = width;
    this.height = height;
    this.canvasWidth = canvasWidth;

    this.n = n;
    this.bbox = { xl: x0, xr: x0 + width, yt: y0, yb: y0 + height };
    this.mapCenter = {
      x: this.bbox.xl + this.width / 2,
      y: this.bbox.yt + this.height / 2,
    };
    this.pixelScale = this.canvasWidth / 3;
    this.targetPolygon = [];
    this.oceanPolygon = [];
    this.colorIndex = 0;
  }

  createMap(regionNum = 5) {
    this.ctx.fillStyle = "#6495ED";
    this.ctx.fillRect(this.bbox.xl, this.bbox.yt, this.width, this.height);
    this.ctx.strokeStyle = "black";
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(this.bbox.xl, this.bbox.yt, this.width, this.height);

    this.drawOcean();

    const scale = 0.9 - regionNum * 0.07;

    const longRadius = this.countOvalRadius(scale);
    const regionCenter = this.randomCenter(regionNum, longRadius);

    _.each(regionCenter, (v, i) => {
      const region1 = [];
      const center = {
        x: v[0],
        y: v[1],
      };

      this.generateRegion(
        this.targetPolygon,
        region1,
        center,
        colors[i % colors.length],
        scale
      );
      // this.ctx.fillStyle = "red";
      // this.ctx.fillRect(v[0], v[1], 10, 10);
    });
  }

  drawOcean() {
    const p = new PoissonDiskSampling({
      shape: [this.bbox.xr, this.bbox.yb],
      minDistance: 20,
      maxDistance: 40,
      tries: 10,
    });
    const points = p.fill();

    this.oceanPolygon = this.voronoi.polygons(points);
    _.each(this.oceanPolygon, (polygon) => {
      if (!polygon || polygon.length < 4) return;

      this.ctx.fillStyle = "#6495ED";

      this.drawPloygon(polygon);
    });
    this.targetPolygon = [...this.oceanPolygon];
  }
  generateRegion(polygons, targetPolygon, centerPoint, targetColor, scale) {
    const bumps = _.random(1, 6);
    const startAngle = _.random(0, 2 * Math.PI);
    const regionPolygons = [];

    _.each(polygons, (polygon) => {
      if (!polygon || polygon.length < 4) return;

      const isLand = this.IsTargetPokygon(
        polygon,
        centerPoint,
        startAngle,
        bumps,
        scale
      );

      if (isLand) {
        targetPolygon.push(polygon);
        regionPolygons.push(polygon);
        this.ctx.fillStyle = targetColor;
        this.drawPloygon(polygon);
      }
    });

    if (regionPolygons.length > 0) {
      this.generateCountries(regionPolygons, 3); // 這裡的 3 改成你想要的數量
    }
  }

  generateCountries(regionPolygons, numCountries = 3, minTiles = 10) {
    const [rcx, rcy] = d3.polygonCentroid(_.flatten(regionPolygons));
  
    // 初步生成中心點
    let centers = _.range(numCountries).map(() => ({
      x: rcx + _.random(-80, 80),
      y: rcy + _.random(-80, 80),
    }));
  
    let countries = Array.from({ length: numCountries }, () => []);
  
    // 初步分配
    regionPolygons.forEach((polygon) => {
      const [cx, cy] = d3.polygonCentroid(polygon);
      let minDist = Infinity, idx = 0;
      centers.forEach((c, i) => {
        const d = (cx - c.x) ** 2 + (cy - c.y) ** 2;
        if (d < minDist) { minDist = d; idx = i; }
      });
      countries[idx].push(polygon);
    });
  
    // 檢查是否有國家太小
    let validCountries = [];
    let orphanPolygons = [];
    countries.forEach((tiles) => {
      if (tiles.length >= minTiles) {
        validCountries.push(tiles);
      } else {
        orphanPolygons.push(...tiles);
      }
    });
  
    // 如果有效國家數量不足 → 強制補到 numCountries
    while (validCountries.length < numCountries) {
      validCountries.push([]); // 建立空國家，稍後分配孤格
    }
  
    // 把孤格重新分配給最近的有效國家
    orphanPolygons.forEach((polygon) => {
      const [cx, cy] = d3.polygonCentroid(polygon);
      let minDist = Infinity, idx = 0;
      validCountries.forEach((tiles, i) => {
        if (tiles.length === 0) { idx = i; return; } // 空國家直接拿
        const [tx, ty] = d3.polygonCentroid(_.flatten(tiles));
        const d = (cx - tx) ** 2 + (cy - ty) ** 2;
        if (d < minDist) { minDist = d; idx = i; }
      });
      validCountries[idx].push(polygon);
    });
  
    // 畫國界：照子格子邊界描
    validCountries.forEach((polys) => {
      if (polys.length === 0) return;
      const edgeMap = new Map();
      polys.forEach((poly) => {
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length];
          const key1 = `${a[0]},${a[1]}-${b[0]},${b[1]}`;
          const key2 = `${b[0]},${b[1]}-${a[0]},${a[1]}`;
          if (edgeMap.has(key2)) edgeMap.delete(key2);
          else edgeMap.set(key1, [a, b]);
        }
      });
      this.ctx.strokeStyle = "red";
      this.ctx.lineWidth = 2;
      edgeMap.forEach(([a, b]) => {
        this.ctx.beginPath();
        this.ctx.moveTo(a[0], a[1]);
        this.ctx.lineTo(b[0], b[1]);
        this.ctx.stroke();
      });
    });
  }

  polygonBounds(polygon) {
    const xs = polygon.map((p) => p[0]);
    const ys = polygon.map((p) => p[1]);
    const [minX, maxX] = d3.extent(xs);
    const [minY, maxY] = d3.extent(ys);
    return [minX, minY, maxX, maxY];
  }
  // 半平面判定：根據 clip 多邊形方向決定使用左側或右側
  insideHalfPlane(pt, edgeStart, edgeEnd, useLeftSide) {
    const [x, y] = pt;
    const [x1, y1] = edgeStart;
    const [x2, y2] = edgeEnd;
    const cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
    return useLeftSide ? cross >= 0 : cross <= 0;
  }

  // 線段與無限直線交點（S-H 足夠）
  segmentIntersection(p1, p2, edgeStart, edgeEnd) {
    const [x1, y1] = p1;
    const [x2, y2] = p2;
    const [x3, y3] = edgeStart;
    const [x4, y4] = edgeEnd;

    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (denom === 0) return null;

    const px =
      ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) /
      denom;
    const py =
      ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) /
      denom;
    return [px, py];
  }

  // 對 subjectPoly 做 Sutherland–Hodgman，clipPoly 必須是凸且有序（polygonHull）
  clipPolygonWithConvex(subjectPoly, clipPoly) {
    if (
      !subjectPoly ||
      subjectPoly.length < 3 ||
      !clipPoly ||
      clipPoly.length < 3
    )
      return null;

    // 根據凸包方向選擇半平面側
    const area = this.polygonSignedArea(clipPoly);
    const useLeftSide = area > 0; // CCW -> 左側為內部；CW -> 右側為內部

    let outputList = subjectPoly;

    for (let i = 0; i < clipPoly.length; i++) {
      const edgeStart = clipPoly[i];
      const edgeEnd = clipPoly[(i + 1) % clipPoly.length];
      const inputList = outputList;
      outputList = [];
      if (!inputList || inputList.length === 0) break;

      for (let j = 0; j < inputList.length; j++) {
        const current = inputList[j];
        const prev = inputList[(j - 1 + inputList.length) % inputList.length];

        const currInside = this.insideHalfPlane(
          current,
          edgeStart,
          edgeEnd,
          useLeftSide
        );
        const prevInside = this.insideHalfPlane(
          prev,
          edgeStart,
          edgeEnd,
          useLeftSide
        );

        if (prevInside && currInside) {
          outputList.push(current);
        } else if (prevInside && !currInside) {
          const inter = this.segmentIntersection(
            prev,
            current,
            edgeStart,
            edgeEnd
          );
          if (inter) outputList.push(inter);
        } else if (!prevInside && currInside) {
          const inter = this.segmentIntersection(
            prev,
            current,
            edgeStart,
            edgeEnd
          );
          if (inter) outputList.push(inter);
          outputList.push(current);
        }
        // both outside: push nothing
      }
    }

    return outputList && outputList.length >= 3 ? outputList : null;
  }

  // 計算多邊形的有號面積（>0 為 CCW 逆時針，<0 為 CW 順時針）
  polygonSignedArea(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      a += x1 * y2 - x2 * y1;
    }
    return a / 2;
  }

  IsTargetPokygon(polygon, centerPoint, startAngle, bumps, scale = 1) {
    const [cx, cy] = d3.polygonCentroid(polygon);

    const distToCenter = Math.sqrt(
      (cx - centerPoint.x) ** 2 + (cy - centerPoint.y) ** 2
    );

    var angle = Math.atan2(cy - centerPoint.x, cx - centerPoint.y);
    var length =
      0.5 *
      (Math.max(Math.abs(cx - centerPoint.x), Math.abs(cy - centerPoint.y)) +
        distToCenter);

    var r1 =
      (0.5 +
        0.4 *
          Math.sin(
            startAngle + bumps * angle + Math.cos((bumps + 3) * angle)
          )) *
      this.pixelScale *
      scale;
    var r2 =
      (0.7 -
        0.2 *
          Math.sin(
            startAngle + bumps * angle - Math.sin((bumps + 2) * angle)
          )) *
      this.pixelScale *
      scale;

    return length < r1 || (length > r1 * ISLAND_FACTOR && length < r2);
  }

  drawPloygon(polygon) {
    this.ctx.beginPath();
    this.ctx.strokeStyle = "#000";
    this.ctx.moveTo(_.first(polygon)[0], _.first(polygon)[1]);
    _.each(_.range(0, polygon.length - 1), (i) => {
      this.ctx.lineTo(polygon[i + 1][0], polygon[i + 1][1]);
    });
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.stroke();
  }

  randomCenter = (num, a) => {
    const h = this.mapCenter.x;
    const k = this.mapCenter.y;
    const b = (a * this.height) / this.width;

    const initCenter = _.random(0, 360);
    const centerDist = Math.round(360 / num);

    const countCoordinate = (t) => {
      return [h + a * Math.cos(t), k + b * Math.sin(t)];
    };

    let angle = initCenter;
    return _.map(_.range(num), (i) => {
      const coordinate = countCoordinate((angle * Math.PI) / 180);

      angle += centerDist;
      if (angle > 360) {
        angle = angle - 360;
      }

      return coordinate;
    });
  };

  countOvalRadius(scale) {
    return scale * 100 * 1.5 + 150;
  }
}
