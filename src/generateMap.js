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
    // ocean frame
    this.ctx.fillStyle = "#6495ED";
    this.ctx.fillRect(this.bbox.xl, this.bbox.yt, this.width, this.height);
    this.ctx.strokeStyle = "black";
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(this.bbox.xl, this.bbox.yt, this.width, this.height);

    // mainland
    this.drawOcean();
    const mainland = this.buildMainland(this.oceanPolygon);
    if (mainland.length === 0) return;

    // region growing + boundary rebalancing
    const {
      groups: regionGroups,
      pool: regionPool,
      idxAdj,
    } = this.growConnectedGroups(mainland, regionNum, minTilesRegion);
    const regions = this.rebalanceBoundaries(
      regionGroups,
      regionPool,
      idxAdj,
      minTilesRegion,
      regionNum
    );

    // draw regions and assign countries per region
    regions.forEach((regionPolys, i) => {
      this.ctx.fillStyle = colors[i % colors.length];
      regionPolys.forEach((poly) => this.drawPloygon(poly));

      const countries = this.assignCountriesWithinRegion(
        regionPolys,
        countriesPerRegion,
        minTilesCountry
      );
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

  // 拆分連通分量：保證同一區域/國家是一整塊
  splitConnectedComponents(polys) {
    if (!polys || polys.length === 0) return [];

    const adj = new Map();
    polys.forEach((_, idx) => adj.set(idx, new Set()));

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

  buildAdjacency(polys) {
    const edgeToIdx = new Map();
    const idxAdj = new Map(); // idx -> Set(idx)
    const E = (a, b) => `${a[0]},${a[1]}-${b[0]},${b[1]}`;
    const R = (a, b) => `${b[0]},${b[1]}-${a[0]},${a[1]}`;

    polys.forEach((poly, idx) => {
      idxAdj.set(idx, new Set());
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i],
          b = poly[(i + 1) % poly.length];
        const k1 = E(a, b),
          k2 = R(a, b);
        if (edgeToIdx.has(k2)) {
          const j = edgeToIdx.get(k2);
          idxAdj.get(idx).add(j);
          idxAdj.get(j).add(idx);
        } else {
          edgeToIdx.set(k1, idx);
        }
      }
    });
    return idxAdj;
  }

  growConnectedGroups(polys, k, minTiles) {
    // seed selection: pick k centroids spread (reuse your center generator or farthest-point)
    const centers = this.generateCentersInPolygons(k, polys);
    const idxAdj = this.buildAdjacency(polys);
    const N = polys.length;

    // map each tile index to nearest center by distance as initial queues
    const tileCentroid = (p) => d3.polygonCentroid(p);
    const centerPos = centers.map((c) => [c.x, c.y]);
    const nearestCenter = new Array(N).fill(-1);
    const queues = Array.from({ length: k }, () => []);
    for (let i = 0; i < N; i++) {
      const [cx, cy] = tileCentroid(polys[i]);
      let best = 0,
        bd = Infinity;
      for (let j = 0; j < k; j++) {
        const [px, py] = centerPos[j];
        const d = (cx - px) * (cx - px) + (cy - py) * (cy - py);
        if (d < bd) {
          bd = d;
          best = j;
        }
      }
      queues[best].push(i);
    }

    // visited assignment
    const assign = new Array(N).fill(-1);
    const fronts = queues.map((q) => new Set(q));

    // multi-source growth: only grow to adjacent unassigned tiles from each frontier
    let progress = true;
    while (progress) {
      progress = false;
      for (let g = 0; g < k; g++) {
        // take a frontier snapshot
        const frontier = Array.from(fronts[g]);
        fronts[g].clear();
        for (const idx of frontier) {
          if (assign[idx] === -1) {
            assign[idx] = g;
            progress = true;
          }
          // push neighbors if unassigned
          idxAdj.get(idx).forEach((nb) => {
            if (assign[nb] === -1) fronts[g].add(nb);
          });
        }
      }
    }

    // build groups
    const groups = Array.from({ length: k }, () => []);
    for (let i = 0; i < N; i++) {
      const g = assign[i] !== -1 ? assign[i] : 0; // fallback
      groups[g].push(polys[i]);
    }

    // connectivity prune: keep largest component per group, send fragments to reassign pool
    const pool = [];
    const connectedGroups = groups.map((g) => {
      const comps = this.splitConnectedComponents(g);
      if (comps.length <= 1) return g;
      comps.sort((a, b) => b.length - a.length);
      for (let i = 1; i < comps.length; i++) pool.push(...comps[i]);
      return comps[0];
    });

    return { groups: connectedGroups, pool, assign, idxAdj };
  }

  rebalanceBoundaries(groups, pool, idxAdj, minTiles, targetCounts) {
    // groups: Array<Polygon[]>, fixed length = targetCounts
    // pool: polygons needing assignment
    const k = groups.length;

    // helper: check donor stays connected after removing a tile
    const staysConnectedAfterRemoval = (groupTiles, removePoly) => {
      const remain = groupTiles.filter((p) => p !== removePoly);
      if (remain.length === 0) return false;
      const comps = this.splitConnectedComponents(remain);
      return comps.length === 1;
    };

    // step A: assign pool tiles to nearest valid group (by centroid distance), preserving connectivity
    const centroidOfGroup = (g) => d3.polygonCentroid(_.flatten(g));
    const groupCenters = groups.map((g) => centroidOfGroup(g));
    const assignToNearest = (poly) => {
      const [cx, cy] = d3.polygonCentroid(poly);
      let best = 0,
        bd = Infinity;
      for (let i = 0; i < k; i++) {
        const [gx, gy] = groupCenters[i];
        const d = (cx - gx) * (cx - gx) + (cy - gy) * (cy - gy);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      groups[best].push(poly);
    };
    pool.forEach(assignToNearest);

    // step B: for groups below minTiles, pull boundary-neighbor tiles from adjacent larger groups
    const groupSize = (i) => groups[i].length;
    const need = [];
    for (let i = 0; i < k; i++) if (groupSize(i) < minTiles) need.push(i);

    // build tile->group map
    const tileToGroup = new Map();
    groups.forEach((g, gi) => g.forEach((p) => tileToGroup.set(p, gi)));

    // detect adjacency between groups via tile neighbors
    const groupNeighbors = Array.from({ length: k }, () => new Set());
    groups.forEach((g, gi) => {
      g.forEach((p, idxInG) => {
        // find neighbors by shared edges among all tiles (approx via centroid proximity is insufficient)
        // brute: check all other tiles once (acceptable for moderate N)
        // optimize in your code with a spatial index
        // here, we skip heavy build and rely on later local scans
      });
    });

    // boundary exchange: iterate limited rounds
    for (let round = 0; round < 20 && need.length; round++) {
      for (const gi of need) {
        // find candidate donors with size > minTiles
        const donors = [];
        for (let gj = 0; gj < k; gj++)
          if (gj !== gi && groups[gj].length > minTiles) donors.push(gj);
        if (!donors.length) continue;

        // seek donor boundary tile adjacent to group gi
        let transferred = false;
        for (const gj of donors) {
          // boundary tiles of donor: tiles that have a neighbor belonging to other groups
          const donorTiles = groups[gj];
          for (const t of donorTiles) {
            // check if t touches any tile in receiver gi
            const touchesReceiver = groups[gi].some((r) =>
              this.shareEdge(t, r)
            );
            if (!touchesReceiver) continue;
            // donor connectivity check
            if (!staysConnectedAfterRemoval(groups[gj], t)) continue;
            // move tile
            groups[gj] = groups[gj].filter((p) => p !== t);
            groups[gi].push(t);
            transferred = true;
            break;
          }
          if (transferred) break;
        }
        // update need list
        if (groups[gi].length >= minTiles) {
          const idx = need.indexOf(gi);
          if (idx >= 0) need.splice(idx, 1);
        }
      }
    }

    return groups;
  }

  // shared-edge check (adjacency by geometry)
  shareEdge(p1, p2) {
    for (let i = 0; i < p1.length; i++) {
      const a1 = p1[i],
        b1 = p1[(i + 1) % p1.length];
      for (let j = 0; j < p2.length; j++) {
        const a2 = p2[j],
          b2 = p2[(j + 1) % p2.length];
        const equal = (u, v) => u[0] === v[0] && u[1] === v[1];
        if (
          (equal(a1, a2) && equal(b1, b2)) ||
          (equal(a1, b2) && equal(b1, a2))
        )
          return true;
      }
    }
    return false;
  }

  assignCountriesWithinRegion(
    regionTiles,
    countriesPerRegion,
    minTilesCountry
  ) {
    const { groups, pool, idxAdj } = this.growConnectedGroups(
      regionTiles,
      countriesPerRegion,
      minTilesCountry
    );
    const balanced = this.rebalanceBoundaries(
      groups,
      pool,
      idxAdj,
      minTilesCountry,
      countriesPerRegion
    );
    return balanced;
  }
}
