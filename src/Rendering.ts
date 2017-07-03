import {CddaData, Mapgen, MapgenObject, PlaceLoot, PlaceMonsters, loadCDDAData} from './CddaData';
import { canvas, VNode } from '@cycle/dom';
import {TabName, ZoneOptions} from './app';
import * as fs from 'fs';
import * as path from 'path';
import * as electron from 'electron';

const imageFromFile = (() => {
  const cache: Record<string, HTMLImageElement> = {}
  return (file: string): HTMLImageElement => {
    if (!(file in cache)) {
      const bytes = fs.readFileSync(file)
      const dataURL = electron.nativeImage.createFromBuffer(bytes).toDataURL()
      const img = new Image
      img.src = dataURL
      cache[file] = img
    }
    return cache[file]
  }
})()

function within(x: number, y: number, xrange: Array<number> | number, yrange: Array<number> | number): boolean {
  const [xLo, xHi] = Array.isArray(xrange) ? [Math.min.apply(null, xrange), Math.max.apply(null, xrange)] : [xrange, xrange];
  const [yLo, yHi] = Array.isArray(yrange) ? [Math.min.apply(null, yrange), Math.max.apply(null, yrange)] : [yrange, yrange];
  return x >= xLo && x <= xHi && y >= yLo && y <= yHi;
}


const WALL_SYMS = new Map()
// L|U|R|D
WALL_SYMS.set((0|0|0|0), "\u00cd")
WALL_SYMS.set((0|0|0|1), "\u00ba")
WALL_SYMS.set((0|0|2|0), "\u00cd")
WALL_SYMS.set((0|0|2|1), "\u00c9")
WALL_SYMS.set((0|4|0|0), "\u00ba")
WALL_SYMS.set((0|4|0|1), "\u00ba")
WALL_SYMS.set((0|4|2|0), "\u00c8")
WALL_SYMS.set((0|4|2|1), "\u00cc")
WALL_SYMS.set((8|0|0|0), "\u00cd")
WALL_SYMS.set((8|0|0|1), "\u00bb")
WALL_SYMS.set((8|0|2|0), "\u00cd")
WALL_SYMS.set((8|0|2|1), "\u00cb")
WALL_SYMS.set((8|4|0|0), "\u00bc")
WALL_SYMS.set((8|4|0|1), "\u00b9")
WALL_SYMS.set((8|4|2|0), "\u00ca")
WALL_SYMS.set((8|4|2|1), "\u00ce")

function determineWallCorner(cddaData: CddaData, obj: MapgenObject, [tx, ty]: [number, number]): string {
  const terrainIdAt = (x: number, y: number): string =>
    (y in obj.rows && x >= 0 && x < obj.rows[y].length && obj.rows[y][x] in obj.terrain)
    ? obj.terrain[obj.rows[y][x]]
    : obj.fill_ter;
  const hasFlag = (ter: any, flag: string): boolean =>
    (ter.flags || []).indexOf(flag) >= 0
  const connectGroup = (ter: any): string =>
    ter.connects_to ||
    (hasFlag(ter, "WALL") || hasFlag(ter, "CONNECT_TO_WALL") ? "WALL" : null);
  const terId = terrainIdAt(tx, ty);
  const ter = cddaData.terrain[terId];
  const connectedLeft = connectGroup(cddaData.terrain[terrainIdAt(tx - 1, ty)]) === connectGroup(ter) ? 1 : 0;
  const connectedUp = connectGroup(cddaData.terrain[terrainIdAt(tx, ty - 1)]) === connectGroup(ter) ? 1 : 0;
  const connectedRight = connectGroup(cddaData.terrain[terrainIdAt(tx + 1, ty)]) === connectGroup(ter) ? 1 : 0;
  const connectedDown = connectGroup(cddaData.terrain[terrainIdAt(tx, ty + 1)]) === connectGroup(ter) ? 1 : 0;
  const dirId = (connectedLeft << 3) | (connectedUp << 2) | (connectedRight << 1) | (connectedDown);
  return WALL_SYMS.get(dirId).charAt(0)
}

export function renderMapgen(
  cddaData: CddaData,
  mapgen: Mapgen,
  tileset: any,
  mouseX: number | null,
  mouseY: number | null,
  paletteTab: TabName,
  zoneOptions: ZoneOptions,
  selectedZone: ['loot' | 'monsters', number] | null,
  intermediateRect: {down: {tx: number, ty: number}, current: {tx: number, ty: number}} | null
): VNode {
  const {config, root} = tileset;
  const {width: tileWidth, height: tileHeight} = config.tile_info[0]
  const fallback = config['tiles-new'].find((x: any) => x.ascii != null)
  const asciiMap = new Map()
  fallback.ascii.forEach(({bold, color, offset}: any) => {
    asciiMap.set(`${color}-${bold}`, offset);
  })
  const {ascii} = fallback
  const tileImage = imageFromFile(path.join(root, fallback.file));
  const tilesPerRow = tileImage.width / tileWidth
  const height = mapgen.object.rows.length
  const width = mapgen.object.rows[0].length

  function drawTile(ctx: CanvasRenderingContext2D, img: HTMLImageElement, offset: number, x: number, y: number): void {
    const ix = offset % tilesPerRow, iy = Math.floor(offset / tilesPerRow);
    ctx.drawImage(img, ix * tileWidth, iy * tileHeight, tileWidth, tileHeight, x * tileWidth, y * tileHeight, tileWidth, tileHeight)
  }

  function getSymbolFor(x: number, y: number): {symbol: string, color: string} {
    // these are `var` instead of `const` because v8 is bad at optimizing consts????
    /* tslint:disable */
    var char = mapgen.object.rows[y][x];
    if (mapgen.object.furniture[char] != null) {
      var furniture = cddaData.furniture[mapgen.object.furniture[char]];
      return {symbol: furniture.symbol, color: furniture.color || ""};
    }
    var terrain = mapgen.object.terrain[char] || mapgen.object.fill_ter;
    var oneTerrain = Array.isArray(terrain) ? terrain[0] : terrain;
    var {symbol, color, flags} = cddaData.terrain[oneTerrain]
    var isAutoWall = flags && flags.indexOf("AUTO_WALL_SYMBOL") >= 0;
    var oneColor = Array.isArray(color) ? color[0] : color;
    var sym = isAutoWall ? determineWallCorner(cddaData, mapgen.object, [x, y]) : symbol;
    /* tslint:enable */
    return {symbol: sym, color: oneColor};
  }

  function draw(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = "black"
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const {symbol, color} = getSymbolFor(x, y);
        const asciiColor = mapColor(color)
        const asciiOffset = asciiMap.get(asciiColor);

        drawTile(ctx, tileImage, asciiOffset + symbol.codePointAt(0), x, y)
      }
    if (paletteTab === 'zone') {
      if (zoneOptions.type === 'loot') {
        (mapgen.object.place_loot || []).forEach((loot: PlaceLoot, idx: number) => {
          const {group, x, y, chance, repeat} = loot;
          const [xLo, xHi] = Array.isArray(x) ? [Math.min.apply(null, x), Math.max.apply(null, x)] : [x, x];
          const [yLo, yHi] = Array.isArray(y) ? [Math.min.apply(null, y), Math.max.apply(null, y)] : [y, y];
          if (selectedZone && selectedZone[0] === 'loot' && selectedZone[1] === idx) {
            ctx.fillStyle = "hsla(39, 100%, 50%, 0.5)"
            ctx.fillRect(tileWidth * xLo + 0.5, tileWidth * yLo + 0.5, tileWidth * (xHi - xLo + 1) - 1, tileHeight * (yHi - yLo + 1) - 1)
          }
          if (mouseX != null && mouseY != null && within(mouseX, mouseY, x, y)) {
            ctx.fillStyle = "hsla(39, 100%, 50%, 0.5)"
            ctx.fillRect(tileWidth * xLo + 0.5, tileWidth * yLo + 0.5, tileWidth * (xHi - xLo + 1) - 1, tileHeight * (yHi - yLo + 1) - 1)
          }
          ctx.strokeStyle = "orange"
          ctx.lineWidth = 1
          ctx.strokeRect(tileWidth * xLo + 0.5, tileWidth * yLo + 0.5, tileWidth * (xHi - xLo + 1) - 1, tileHeight * (yHi - yLo + 1) - 1);
        });
        if (intermediateRect != null) {
          const xLo = Math.min(intermediateRect.down.tx, intermediateRect.current.tx)
          const xHi = Math.max(intermediateRect.down.tx, intermediateRect.current.tx)
          const yLo = Math.min(intermediateRect.down.ty, intermediateRect.current.ty)
          const yHi = Math.max(intermediateRect.down.ty, intermediateRect.current.ty)
          ctx.strokeStyle = "orange"
          ctx.lineWidth = 1
          ctx.strokeRect(tileWidth * xLo + 0.5, tileWidth * yLo + 0.5, tileWidth * (xHi - xLo + 1) - 1, tileHeight * (yHi - yLo + 1) - 1);
        }
      } else if (zoneOptions.type === 'monsters') {
        (mapgen.object.place_monsters || []).forEach((mon: PlaceMonsters, idx: number) => {
          const {monster, x, y, chance, repeat} = mon;
          const [xLo, xHi] = Array.isArray(x) ? [Math.min.apply(null, x), Math.max.apply(null, x)] : [x, x];
          const [yLo, yHi] = Array.isArray(y) ? [Math.min.apply(null, y), Math.max.apply(null, y)] : [y, y];
          if (selectedZone && selectedZone[0] === 'monsters' && selectedZone[1] === idx) {
            ctx.fillStyle = "hsla(120, 100%, 25%, 0.5)"
            ctx.fillRect(tileWidth * xLo + 0.5, tileWidth * yLo + 0.5, tileWidth * (xHi - xLo + 1) - 1, tileHeight * (yHi - yLo + 1) - 1)
          }
          if (mouseX != null && mouseY != null && within(mouseX, mouseY, x, y)) {
            ctx.fillStyle = "hsla(120, 100%, 25%, 0.5)"
            ctx.fillRect(tileWidth * xLo + 0.5, tileWidth * yLo + 0.5, tileWidth * (xHi - xLo + 1) - 1, tileHeight * (yHi - yLo + 1) - 1)
          }
          ctx.strokeStyle = "green"
          ctx.lineWidth = 1
          ctx.strokeRect(tileWidth * xLo + 0.5, tileWidth * yLo + 0.5, tileWidth * (xHi - xLo + 1) - 1, tileHeight * (yHi - yLo + 1) - 1);
        })
        if (intermediateRect != null) {
          const xLo = Math.min(intermediateRect.down.tx, intermediateRect.current.tx)
          const xHi = Math.max(intermediateRect.down.tx, intermediateRect.current.tx)
          const yLo = Math.min(intermediateRect.down.ty, intermediateRect.current.ty)
          const yHi = Math.max(intermediateRect.down.ty, intermediateRect.current.ty)
          ctx.strokeStyle = "green"
          ctx.lineWidth = 1
          ctx.strokeRect(tileWidth * xLo + 0.5, tileWidth * yLo + 0.5, tileWidth * (xHi - xLo + 1) - 1, tileHeight * (yHi - yLo + 1) - 1);
        }
      }
    } else {
      if (mouseX != null && mouseY != null) {
        ctx.strokeStyle = "red"
        ctx.lineWidth = 4
        ctx.strokeRect(tileWidth * mouseX, tileHeight * mouseY, tileWidth, tileHeight)
      }
    }
  }

  return canvas('.mapgen',
    {
      style: {
        cursor: 'default'
      },
      attrs: {
        width: width * tileWidth,
        height: height * tileHeight
      },
      hook: {
        insert: ({elm}: {elm: HTMLCanvasElement}) => draw(elm.getContext('2d') as CanvasRenderingContext2D),
        update: ({elm}: {elm: HTMLCanvasElement}) => draw(elm.getContext('2d') as CanvasRenderingContext2D)
      }
    }
  )
}

export function renderTile(cddaData: any, tileset: any, terrainId: string, furnitureId: string, selected: boolean): VNode {
  const {config, root} = tileset;
  const {width: tileWidth, height: tileHeight} = config.tile_info[0]
  const fallback = config['tiles-new'].find((x: any) => 'ascii' in x)
  const asciiMap = new Map()
  fallback.ascii.forEach(({bold, color, offset}: any) => {
    asciiMap.set(`${color}-${bold}`, offset);
  })
  const {ascii} = fallback
  const tileImage = imageFromFile(path.join(root, fallback.file));
  const tilesPerRow = tileImage.width / tileWidth

  function getSymbolFor(tId: string, fId: string): {symbol: string, color: string} {
    if (fId != null) {
      const furniture = cddaData.furniture[fId];
      return {symbol: furniture.symbol, color: furniture.color || ""};
    }
    const oneTerrainId = Array.isArray(tId) ? tId[0] : tId;
    const {symbol, color, flags} = cddaData.terrain[oneTerrainId]
    const isAutoWall = flags && flags.indexOf("AUTO_WALL_SYMBOL") >= 0;
    const oneColor = Array.isArray(color) ? color[0] : color;
    const sym = isAutoWall ? WALL_SYMS.get(0) : symbol;
    return {symbol: sym, color: oneColor};
  }

  function drawTile(ctx: CanvasRenderingContext2D, img: HTMLImageElement, offset: number, x: number, y: number): void {
    const ix = offset % tilesPerRow, iy = Math.floor(offset / tilesPerRow);
    ctx.drawImage(img, ix * tileWidth, iy * tileHeight, tileWidth, tileHeight, x * tileWidth, y * tileHeight, tileWidth, tileHeight)
  }


  function draw(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = selected ? 'red' : 'black'
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    const {symbol, color} = getSymbolFor(terrainId, furnitureId);
    const asciiColor = mapColor(color)
    const asciiOffset = asciiMap.get(asciiColor);

    drawTile(ctx, tileImage, asciiOffset + symbol.codePointAt(0), 0, 0)
  }

  return canvas('.terrainButton',
    {
      attrs: {width: tileWidth, height: tileHeight},
      hook: {
        insert: ({elm}: {elm: HTMLCanvasElement}) => draw(elm.getContext('2d') as CanvasRenderingContext2D),
        update: ({elm}: {elm: HTMLCanvasElement}) => draw(elm.getContext('2d') as CanvasRenderingContext2D)
      }
    }
  )
}

function mapColor(color: string): string {
  switch (color) {
    case "dkgray": return "BLACK-true"
    case "red": return "RED-false"
    case "ltred_green": return "RED-true"
    case "green": return "GREEN-false"
    case "ltgreen": return "GREEN-true"
    case "light_green": return "GREEN-true"
    case "brown": return "YELLOW-false"
    case "blue": return "BLUE-false"
    case "magenta": return "MAGENTA-false"
    case "cyan": return "CYAN-false"
    case "ltcyan": return "CYAN-true"
    case "white": return "WHITE-false"
    case "ltgray": return "WHITE-true"
    case "ltred": return "RED-true"
    case "yellow": return "YELLOW-true"
    case "black_white": return "BLACK-false"
    case "black": return "BLACK-false"
    case "": return "WHITE-false"
    default: console.error(`missing fg ${color}`); return "WHITE-false"
  }
}
