import xs, { Stream } from 'xstream';
import { VNode, DOMSource, svg, canvas, input } from '@cycle/dom';
import { StateSource } from 'cycle-onionify';

import { Sources, Sinks } from './interfaces';

import * as fs from 'fs';
import * as path from 'path';
import * as electron from 'electron';
import * as glob from 'glob';

export type AppSources = Sources & { onion : StateSource<AppState> };
export type AppSinks = Sinks & { onion : Stream<Reducer> };
export type Reducer = (prev : AppState) => AppState;
export type AppState = {
  count : number;
};

function loadCDDAData(root: string): any {
  const filenames = glob.sync(root + '/data/json/**/*.json', {nodir: true});
  const objects = Array.prototype.concat.apply([], filenames.map(fn => {
    const json = JSON.parse(fs.readFileSync(fn))
    return Array.isArray(json) ? json : [json];
  }));
  const tilesetConfigs = glob.sync(root + '/gfx/*/tile_config.json')
  const tilesets = tilesetConfigs.map(fn => {
    const tsRoot = path.dirname(fn)
    try {
      const tileConfig = JSON.parse(fs.readFileSync(fn))
      return {root: tsRoot, config: tileConfig};
    } catch (e) {
      return {root: tsRoot, config: {}};
    }
  }).filter(({config}) => 'tiles-new' in config);
  const terrain = {};
  objects.filter(o => o.type === 'terrain').forEach(t => terrain[t.id] = t);
  const furniture = {};
  objects.filter(o => o.type === 'furniture').forEach(t => furniture[t.id] = t);
  return {objects, terrain, furniture, tilesets};
}

export function App(sources : AppSources) : AppSinks
{
  const selectRoot$ = sources.DOM.select('.selectRoot').events('click').mapTo({dialog: 'open', category: 'cdda-root', options: {properties: ['openDirectory']}});
  const action$ = intent(sources.DOM, sources.electron);
  const vdom$ = view(sources.onion.state$);

  return {
    DOM: vdom$,
    onion: action$,
    electron: selectRoot$
  };
}

function intent(DOM : DOMSource, electron) : Stream<Reducer>
{
  const init$ = xs.of(() => {
    const cddaRoot = "/Users/nornagon/Source/Cataclysm-DDA";
    const cddaData = loadCDDAData(cddaRoot);
    const tileset = cddaData.tilesets.find(x => /ChestHoleTileset/.test(x.root))
    return {
      cddaRoot,
      cddaData,
      mapgen: cddaData.objects.filter(o => o.type === 'mapgen')[25],
      tileset,
      selectedTerrainId: " ",
    }
  });

  const selectRoot$ = electron.map(e => state => {
    return ({...state, cddaRoot: e[0], cddaData: loadCDDAData(e[0])})
  })

  const mousePos$ = DOM.select('canvas').events('mousemove').map(e => state => {
    const {config: {tile_info: [{width, height}]}} = state.tileset
    return {...state, mouseX: (e.offsetX / width)|0, mouseY: (e.offsetY / height)|0};
  })

  const selectTerrain$ = DOM.select('.terrain').events('change').map(e => state => {
    return {...state, selectedTerrainId: e.target.terrainId};
  })

  const drawTerrain$ = DOM.select('canvas').events('mousedown').map(e => state => {
    const rows = [...state.mapgen.object.rows];
    const {config: {tile_info: [{width, height}]}} = state.tileset
    const tx = (e.offsetX/width)|0, ty = (e.offsetY/height)|0;
    let row = rows[ty];
    row = row.substring(0, tx) + state.selectedTerrainId + row.substring(tx+1)
    rows[ty] = row
    console.log(row);
    console.log(tx, ty);
    return {...state, mapgen: {...state.mapgen, object: {...state.mapgen.object, rows}}}
  })

  return xs.merge(init$, selectRoot$, mousePos$, selectTerrain$, drawTerrain$);
}

function view(state$ : Stream<AppState>) : Stream<VNode>
{
  return state$
    .map(state =>
      <div>
      {state.cddaRoot == null
        ? <button className='selectRoot'>Select CDDA root</button>
        : renderMain(state)}
      </div>
    );
}
function renderMain(state) {
  const terrains = Object.keys(state.mapgen.object.terrain);
  let hovered;
  if (state.mouseX != null) {
    hovered = {
      terrain: state.mapgen.object.terrain[state.mapgen.object.rows[state.mouseY][state.mouseX]] || state.mapgen.object.fill_ter,
      furniture: state.mapgen.object.furniture[state.mapgen.object.rows[state.mouseY][state.mouseX]]
    }
  }
  return <div>
    {/*<p>CDDA root: {state.cddaRoot}</p>*/}
    {/*<p>Objects: {state.cddaData.objects.length} ({['mapgen', 'terrain', 'item_group', 'furniture'].map(ty => state.cddaData.objects.filter(o => o.type === ty).length + ` ${ty}s`).join(', ')})</p>*/}
    <div>{terrains.map(tId =>
      <span>{input('.terrain', {attrs: {type:'radio'}, props:{checked:tId === state.selectedTerrainId, terrainId: tId}})} {tId}</span>
    )}</div>
    {!!hovered &&
      <p>Hovered: {hovered.terrain}{hovered.furniture && ` / ${hovered.furniture}`}</p>}
    {renderMapgen(state.cddaData, state.mapgen, state.tileset, {mouseX: state.mouseX, mouseY: state.mouseY})}
  </div>
}

const imageFromFile = (() => {
  const cache = {}
  return (file: string) => {
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

const WALL_SYMS = new Map()
// L|U|R|D
WALL_SYMS.set((0|0|0|0), "\u00cd")
WALL_SYMS.set((0|0|0|1), "\u00ba")
WALL_SYMS.set((0|0|2|0), "\u00cd")
WALL_SYMS.set((0|0|2|1), "\u00c9")
WALL_SYMS.set((0|4|0|0), "\u00ba︎︎")
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

function determineWallCorner(cddaData, obj, [tx, ty]) {
  const terrainIdAt = (x, y) => (y in obj.rows && x >= 0 && x < obj.rows[y].length && obj.rows[y][x] in obj.terrain) ? obj.terrain[obj.rows[y][x]] : obj.fill_ter;
  const connectGroup = (ter) => ter.connects_to || (ter.flags.indexOf("WALL") >= 0 || ter.flags.indexOf("CONNECT_TO_WALL") >= 0 ? "WALL" : null);
  const terId = terrainIdAt(tx, ty)
  const ter = cddaData.terrain[terId]
  const connectedLeft = connectGroup(cddaData.terrain[terrainIdAt(tx - 1, ty)]) === connectGroup(ter)
  const connectedUp = connectGroup(cddaData.terrain[terrainIdAt(tx, ty - 1)]) === connectGroup(ter)
  const connectedRight = connectGroup(cddaData.terrain[terrainIdAt(tx + 1, ty)]) === connectGroup(ter)
  const connectedDown = connectGroup(cddaData.terrain[terrainIdAt(tx, ty + 1)]) === connectGroup(ter)
  const dirId = (connectedLeft << 3) | (connectedUp << 2) | (connectedRight << 1) | (connectedDown);
  return WALL_SYMS.get(dirId).charAt(0)
}

function renderMapgen(cddaData, mapgen, tileset, {mouseX, mouseY}) {
  const {config, root} = tileset;
  const {width: tileWidth, height: tileHeight} = config.tile_info[0]
  const fallback = config['tiles-new'].find(x => 'ascii' in x)
  const asciiMap = new Map()
  fallback.ascii.forEach(({bold, color, offset}) => {
    asciiMap.set(`${color}-${bold}`, offset);
  })
  const {ascii} = fallback
  const tileImage = imageFromFile(path.join(root, fallback.file));
  const tilesPerRow = tileImage.width / tileWidth
  const height = mapgen.object.rows.length
  const width = mapgen.object.rows[0].length

  function drawTile(ctx, img, offset, x, y) {
    const ix = offset % tilesPerRow, iy = Math.floor(offset / tilesPerRow);
    ctx.drawImage(img, ix * tileWidth, iy * tileHeight, tileWidth, tileHeight, x * tileWidth, y * tileHeight, tileWidth, tileHeight)
  }

  function mapColor(color: string): string {
    switch (color) {
      case "dkgray": return "BLACK-true"
      case "red": return "RED-false"
      case "ltred_green": return "RED-true"
      case "green": return "GREEN-false"
      case "ltgreen": return "GREEN-true"
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
      case "": return "DEFAULT-false"
      default: console.error(`missing fg ${color}`); return "DEFAULT-false"
    }
  }

  function getSymbolFor(x, y) {
    const char = mapgen.object.rows[y][x];
    if (char in mapgen.object.furniture) {
      const furniture = cddaData.furniture[mapgen.object.furniture[char]];
      return {symbol: furniture.symbol, color: furniture.color || ""};
    }
    const terrain = mapgen.object.terrain[char] || mapgen.object.fill_ter;
    const oneTerrain = Array.isArray(terrain) ? terrain[0] : terrain;
    const {symbol, color, flags} = cddaData.terrain[oneTerrain]
    const isAutoWall = flags && flags.indexOf("AUTO_WALL_SYMBOL") >= 0;
    const oneColor = Array.isArray(color) ? color[0] : color;
    const sym = isAutoWall ? determineWallCorner(cddaData, mapgen.object, [x, y]) : symbol;
    return {symbol: sym, color: oneColor};
  }

  function draw(ctx) {
    ctx.fillStyle = "black"
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const {symbol, color} = getSymbolFor(x, y);
        const asciiColor = mapColor(color)
        const asciiOffset = asciiMap.get(asciiColor);

        drawTile(ctx, tileImage, asciiOffset + symbol.codePointAt(0), x, y)
      }
    ctx.strokeStyle = "red"
    ctx.lineWidth = 3
    ctx.strokeRect(tileWidth * mouseX, tileHeight * mouseY, tileWidth, tileHeight)
  }

  return canvas(
    {attrs: {width: width * tileWidth, height: height * tileHeight}, hook: {insert: ({elm}) => draw(elm.getContext('2d')), update: ({elm}) => draw(elm.getContext('2d'))}}
  )

  return svg([
    svg.image({attrs: {'xlink:href': `file://${tileImage}`}})
  ])
}
