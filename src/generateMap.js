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

  // Entry: generate mainland → regions → countries
  createMap(
    regionNum = 5,
    countriesPerRegion = 3,
    minTilesRegion = 30,
    minTilesCountry = 10
  ) {
    // 1) 畫海洋背景
    this.ctx.fillStyle = "#6495ED";
    this.ctx.fillRect(this.bbox.xl, this.bbox.yt, this.width, this.height);
    this.ctx.strokeStyle = "black";
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(this.bbox.xl, this.bbox.yt, this.width, this.height);

    // 2) 生成大陸格子
    this.drawOcean();
    const mainland = this.buildMainland(this.oceanPolygon);
    const totalTiles = mainland.length;
    if (totalTiles === 0) return;

    // 3) 分配區域（固定數量 + 最小格數 + 連通性）
    const regions = this.forceAssignWithConnectivity(
      mainland,
      regionNum,
      minTilesRegion
    );

    // 4) 畫區域 & 切國家
    regions.forEach((regionPolys, i) => {
      // 畫區域
      this.ctx.fillStyle = colors[i % colors.length];
      regionPolys.forEach((poly) => this.drawPloygon(poly));

      // 5) 分配國家（固定數量 + 最小格數 + 連通性）
      const countries = this.forceAssignWithConnectivity(
        regionPolys,
        countriesPerRegion,
        minTilesCountry
      );

      // 畫國界
      countries.forEach((polys) => this.drawBorders(polys, "red", 2));
    });
  }
  // Base Voronoi cells over the canvas
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

  // Build one contiguous mainland from ocean cells using island function, then keep largest connected component
  buildMainland(polygons) {
    const bumps = 3;
    const startAngle = 0;
    const scale = 1;

    // Select tiles that satisfy island function around mapCenter
    const candidate = [];
    _.each(polygons, (polygon) => {
      if (!polygon || polygon.length < 4) return;
      const isLand = this.IsTargetPokygon(
        polygon,
        this.mapCenter,
        startAngle,
        bumps,
        scale
      );
      if (isLand) candidate.push(polygon);
    });

    if (candidate.length === 0) return [];

    // Keep largest connected component to avoid islands/fragments
    const largest = this.largestConnectedComponent(candidate);
    return largest;
  }

  // Simple adjacency via shared edge (exact vertex match)
  largestConnectedComponent(polys) {
    const edges = new Map();
    const keyEdge = (a, b) => `${a[0]},${a[1]}-${b[0]},${b[1]}`;
    const addEdge = (a, b, idx) => {
      const k1 = keyEdge(a, b);
      const k2 = keyEdge(b, a);
      if (edges.has(k2)) {
        edges.get(k2).push(idx);
      } else {
        if (!edges.has(k1)) edges.set(k1, []);
        edges.get(k1).push(idx);
      }
    };

    polys.forEach((poly, idx) => {
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        addEdge(a, b, idx);
      }
    });

    const adj = new Map();
    polys.forEach((_, idx) => adj.set(idx, new Set()));
    edges.forEach((list) => {
      if (list.length >= 2) {
        // shared edge between tiles
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            adj.get(list[i]).add(list[j]);
            adj.get(list[j]).add(list[i]);
          }
        }
      }
    });

    // BFS to get connected components
    const visited = new Array(polys.length).fill(false);
    let bestComp = [];
    for (let i = 0; i < polys.length; i++) {
      if (visited[i]) continue;
      const queue = [i];
      const comp = [];
      visited[i] = true;
      while (queue.length) {
        const u = queue.shift();
        comp.push(polys[u]);
        adj.get(u).forEach((v) => {
          if (!visited[v]) {
            visited[v] = true;
            queue.push(v);
          }
        });
      }
      if (comp.length > bestComp.length) bestComp = comp;
    }
    return bestComp;
  }

  // Generate centers uniformly inside polygon set hull via Poisson + rejection
  generateCentersInPolygons(num, polygons) {
    const hull = d3.polygonHull(_.flatten(polygons));
    if (!hull || hull.length < 3) {
      // Fallback: center around mapCenter
      return _.range(num).map(() => ({
        x: this.mapCenter.x + _.random(-80, 80, true),
        y: this.mapCenter.y + _.random(-80, 80, true),
      }));
    }

    const minX = d3.min(hull.map((p) => p[0]));
    const maxX = d3.max(hull.map((p) => p[0]));
    const minY = d3.min(hull.map((p) => p[1]));
    const maxY = d3.max(hull.map((p) => p[1]));

    const pds = new PoissonDiskSampling({
      shape: [maxX - minX, maxY - minY],
      minDistance: Math.max(30, (maxX - minX + (maxY - minY)) / 40),
      maxDistance: Math.max(60, (maxX - minX + (maxY - minY)) / 25),
      tries: 30,
    });

    const raw = pds.fill();
    const centers = [];
    for (let i = 0; i < raw.length && centers.length < num; i++) {
      const [x, y] = raw[i];
      const candidate = [x + minX, y + minY];
      if (d3.polygonContains(hull, candidate)) {
        centers.push({ x: candidate[0], y: candidate[1] });
      }
    }

    // If Poisson produces fewer than needed, top up with rejection sampling
    let guard = 0;
    while (centers.length < num && guard < 5000) {
      guard++;
      const cx = _.random(minX, maxX, true);
      const cy = _.random(minY, maxY, true);
      if (d3.polygonContains(hull, [cx, cy])) centers.push({ x: cx, y: cy });
    }

    return centers;
  }

  // Assign tiles to nearest center; enforce minimum tiles by merging orphans to nearest valid group
  assignPolygonsToCenters(polygons, centers, minTiles) {
    let groups = Array.from({ length: centers.length }, () => []);

    // Initial assignment by nearest center
    polygons.forEach((poly) => {
      const [cx, cy] = d3.polygonCentroid(poly);
      let minDist = Infinity,
        idx = 0;
      centers.forEach((c, i) => {
        const d = (cx - c.x) ** 2 + (cy - c.y) ** 2;
        if (d < minDist) {
          minDist = d;
          idx = i;
        }
      });
      groups[idx].push(poly);
    });

    // Filter groups by minTiles; collect orphans
    const valid = [];
    const orphans = [];
    groups.forEach((g) => {
      if (g.length >= minTiles) valid.push(g);
      else orphans.push(...g);
    });

    // If valid fewer than centers, pad with empty groups to keep target count
    while (valid.length < centers.length) valid.push([]);

    // Reassign orphans to nearest valid group centroid
    orphans.forEach((poly) => {
      const [cx, cy] = d3.polygonCentroid(poly);
      let minDist = Infinity,
        idx = 0;
      valid.forEach((g, i) => {
        if (g.length === 0) {
          idx = i; // give to empty group first
          minDist = -1;
          return;
        }
        const [tx, ty] = d3.polygonCentroid(_.flatten(g));
        const d = (cx - tx) ** 2 + (cy - ty) ** 2;
        if (d < minDist) {
          minDist = d;
          idx = i;
        }
      });
      valid[idx].push(poly);
    });

    return valid;
  }

  forceAssign(polygons, numGroups, minTiles) {
    // 1. 初步分配
    let groups = this.assignPolygonsToCenters(
      polygons,
      this.generateCentersInPolygons(numGroups, polygons),
      1
    );

    // 2. 合併太小的 group
    groups = groups.filter((g) => g.length > 0);
    groups.forEach((g, i) => {
      if (g.length < minTiles) {
        // 把 g 合併到最近的大 group
        g.forEach((poly) => {
          const [cx, cy] = d3.polygonCentroid(poly);
          let minDist = Infinity,
            idx = 0;
          groups.forEach((gg, j) => {
            if (gg.length >= minTiles) {
              const [tx, ty] = d3.polygonCentroid(_.flatten(gg));
              const d = (cx - tx) ** 2 + (cy - ty) ** 2;
              if (d < minDist) {
                minDist = d;
                idx = j;
              }
            }
          });
          groups[idx].push(poly);
        });
        groups[i] = [];
      }
    });
    groups = groups.filter((g) => g.length > 0);

    // 3. 如果數量不足 → 從最大 group 拆分
    while (groups.length < numGroups) {
      const largestIdx = _.maxBy(
        _.range(groups.length),
        (i) => groups[i].length
      );
      const largest = groups[largestIdx];
      const half = Math.floor(largest.length / 2);
      const newGroup = largest.splice(0, half);
      groups.push(newGroup);
    }

    return groups;
  }

  forceAssignWithConnectivity(polygons, numGroups, minTiles) {
    // 初步分配
    let centers = this.generateCentersInPolygons(numGroups, polygons);
    let groups = Array.from({ length: numGroups }, () => []);
    polygons.forEach((poly) => {
      const [cx, cy] = d3.polygonCentroid(poly);
      let minDist = Infinity,
        idx = 0;
      centers.forEach((c, i) => {
        const d = (cx - c.x) ** 2 + (cy - c.y) ** 2;
        if (d < minDist) {
          minDist = d;
          idx = i;
        }
      });
      groups[idx].push(poly);
    });

    // 檢查連通性：拆成連通分量
    const connectedGroups = [];
    groups.forEach((g) => {
      const comps = this.splitConnectedComponents(g);
      connectedGroups.push(...comps);
    });

    // 合併太小的分量
    const validGroups = [];
    const orphans = [];
    connectedGroups.forEach((g) => {
      if (g.length >= minTiles) validGroups.push(g);
      else orphans.push(...g);
    });

    // 把孤格合併到最近的大國
    orphans.forEach((poly) => {
      const [cx, cy] = d3.polygonCentroid(poly);
      let minDist = Infinity,
        idx = 0;
      validGroups.forEach((g, i) => {
        const [tx, ty] = d3.polygonCentroid(_.flatten(g));
        const d = (cx - tx) ** 2 + (cy - ty) ** 2;
        if (d < minDist) {
          minDist = d;
          idx = i;
        }
      });
      validGroups[idx].push(poly);
    });

    // 如果數量不足 → 從最大 group 拆分
    while (validGroups.length < numGroups) {
      const largestIdx = _.maxBy(
        _.range(validGroups.length),
        (i) => validGroups[i].length
      );
      const largest = validGroups[largestIdx];
      if (largest.length <= minTiles * 2) break;
      const half = Math.floor(largest.length / 2);
      const newGroup = largest.splice(0, half);
      validGroups.push(newGroup);
    }

    return validGroups;
  }

  splitConnectedComponents(polys) {
    if (!polys || polys.length === 0) return [];

    // 建立 adjacency map
    const adj = new Map();
    polys.forEach((_, idx) => adj.set(idx, new Set()));

    // 建立邊索引
    const edgeMap = new Map();
    const key = (a, b) => `${a[0]},${a[1]}-${b[0]},${b[1]}`;
    const rev = (a, b) => `${b[0]},${b[1]}-${a[0]},${a[1]}`;

    polys.forEach((poly, idx) => {
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const k1 = key(a, b);
        const k2 = rev(a, b);
        if (edgeMap.has(k2)) {
          const otherIdx = edgeMap.get(k2);
          adj.get(idx).add(otherIdx);
          adj.get(otherIdx).add(idx);
        } else {
          edgeMap.set(k1, idx);
        }
      }
    });

    // BFS 拆分成連通分量
    const visited = new Array(polys.length).fill(false);
    const components = [];

    for (let i = 0; i < polys.length; i++) {
      if (visited[i]) continue;
      const queue = [i];
      const comp = [];
      visited[i] = true;
      while (queue.length) {
        const u = queue.shift();
        comp.push(polys[u]);
        adj.get(u).forEach((v) => {
          if (!visited[v]) {
            visited[v] = true;
            queue.push(v);
          }
        });
      }
      components.push(comp);
    }

    return components;
  }

  // Draw borders by following child tile edges; remove internal shared edges
  drawBorders(polys, color = "red", lineWidth = 2) {
    const edgeMap = new Map();
    const key = (a, b) => `${a[0]},${a[1]}-${b[0]},${b[1]}`;
    const rev = (a, b) => `${b[0]},${b[1]}-${a[0]},${a[1]}`;

    polys.forEach((poly) => {
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const k1 = key(a, b);
        const k2 = rev(a, b);
        if (edgeMap.has(k2)) {
          // internal edge: remove reverse
          edgeMap.delete(k2);
        } else {
          edgeMap.set(k1, [a, b]);
        }
      }
    });

    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = lineWidth;
    edgeMap.forEach(([a, b]) => {
      this.ctx.beginPath();
      this.ctx.moveTo(a[0], a[1]);
      this.ctx.lineTo(b[0], b[1]);
      this.ctx.stroke();
    });
  }

  // Original island selection function (used for mainland selection)
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

  // Legacy helpers kept (not used for region centers now)
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
