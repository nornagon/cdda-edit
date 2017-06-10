import xs, { Stream } from 'xstream';
import { VNode, DOMSource, svg, canvas, input } from '@cycle/dom';
import * as dom from '@cycle/dom';
import isolate from '@cycle/isolate';
import { StateSource } from 'cycle-onionify';

import { Sources, Sinks } from './interfaces';
import {IdSelector} from './IdSelector';
import Styles from './styles';

import * as fs from 'fs';
import * as path from 'path';
import * as electron from 'electron';
import * as glob from 'glob';
import * as stringify from 'json-beautify';

export type AppSources = Sources & { onion: StateSource<AppState> };
export type AppSinks = Sinks & { onion: Stream<Reducer> };
export type Reducer = (prev: AppState) => AppState;
type TabName = "map" | "zone";
interface Mapgen {
  type: "mapgen";
  object: MapgenObject;
  method: "json" | "lua";
  weight?: number;
}
interface MapgenObject {
  fill_ter: string;
  rows: Array<string>;
  terrain: {[sym: string]: any};
  furniture: {[sym: string]: any};
  place_loot?: Array<PlaceLoot>;
}
type PlaceLoot = any;
export type AppState = {
  cddaRoot?: string,
  cddaData?: any,
  mapgen: Mapgen,
  tileset: any,
  selectedSymbolId: string,
  editing?: any,
  mouseX: number | null,
  mouseY: number | null,
  paletteTab: TabName,
};

/**
 * source: --a--b----c----d---e-f--g----h---i--j-----
 * first:  -------F------------------F---------------
 * second: -----------------S-----------------S------
 *                         between
 * output: ----------c----d-------------h---i--------
 */
function between(first: Stream<any>, second: Stream<any>): <T>(source: Stream<T>) => Stream<T> {
  return (source: Stream<any>) => first.mapTo(source.endWhen(second)).flatten()
}


function loadCDDAData(root: string): any {
  const filenames = glob.sync(root + '/data/json/**/*.json', {nodir: true});
  const objects = Array.prototype.concat.apply([], filenames.map((fn: string) => {
    const json = JSON.parse(fs.readFileSync(fn).toString())
    return (Array.isArray(json) ? json : [json]).map((x, i) => ({...x, _source: [fn, i]}));
  }));
  const tilesetConfigs = glob.sync(root + '/gfx/*/tile_config.json')
  const tilesets = tilesetConfigs.map((fn: string) => {
    const tsRoot = path.dirname(fn)
    try {
      const tileConfig = JSON.parse(fs.readFileSync(fn).toString())
      return {root: tsRoot, config: tileConfig};
    } catch (e) {
      return {root: tsRoot, config: {}};
    }
  }).filter(({config}: any) => 'tiles-new' in config);
  const terrain: {[id: string]: any} = {};
  objects.filter((o: any) => o.type === 'terrain').forEach((t: any) => terrain[t.id] = t);
  const furniture: {[id: string]: any} = {};
  objects.filter((o: any) => o.type === 'furniture').forEach((t: any) => furniture[t.id] = t);

  return {objects, terrain, furniture, tilesets};
}

export function App(sources : AppSources) : AppSinks
{
  const selectRoot$ = sources.DOM.select('.selectRoot').events('click').mapTo({dialog: 'open', category: 'cdda-root', options: {properties: ['openDirectory']}});

  /*const save$ = xs.combine(
    sources.DOM.select('.save').events('click'),
    sources.onion.state$
  ).map(([e, state]) => {
    const mapgen = {...state.mapgen};
    delete mapgen._source;
    const data = stringify([mapgen], null, 2, 100) + "\n";
    return {
      type: 'writeFile',
      fileName: state.mapgen._source[0],
      data
    };
  });*/

  const selectorLens = {
    get: (state: AppState) => {
      const items = state.editing ?
        state.cddaData[state.editing.type === 'fill_ter' ? 'terrain' : state.editing.type] : {};
      return {
        ...state.editing,
        cddaData: state.cddaData,
        items
      }
    },
    set: (state: AppState, childState) => {
      const {cddaData: _, ...rest} = childState;
      return {...state, editing: rest}
    }
  };

  const {choose, ...selectorSinks} = isolate(IdSelector, {onion: selectorLens})(sources)

  const action$: Stream<Reducer> = intent(sources.DOM, sources.electron, choose);

  const vdom$ = view(sources.onion.state$.debug('state'), selectorSinks.DOM);

  return {
    DOM: vdom$,
    onion: xs.merge(action$, selectorSinks.onion),
    electron: xs.merge(selectRoot$),
  };
}

function intent(DOM : DOMSource, electro, choose: Stream<string>) : Stream<Reducer>
{
  const init$: Stream<Reducer> = xs.of((): AppState => {
    const cddaRoot = "/Users/nornagon/Source/Cataclysm-DDA";
    const cddaData = loadCDDAData(cddaRoot);
    const tileset = cddaData.tilesets.find((x: any) => /ChestHoleTileset/.test(x.root))
    electron.remote.getCurrentWindow().setContentSize(tileset.config.tile_info[0].width * (24 + 13), tileset.config.tile_info[0].height * 24)
    return {
      cddaRoot,
      cddaData,
      mapgen: cddaData.objects.filter((o: any) => o.type === 'mapgen')[25],
      tileset,
      selectedSymbolId: " ",
      mouseX: null,
      mouseY: null,
      paletteTab: "map",
    }
  });

  const selectRoot$: Stream<Reducer> = electro.map(e => (state: AppState): AppState => {
    return ({...state, cddaRoot: e[0], cddaData: loadCDDAData(e[0])})
  })

  const mousePos$ = xs.merge(DOM.select('canvas.mapgen').events('mousemove'), DOM.select('canvas.mapgen').events('mouseout').map(e => null));

  const mouseTilePos$: Stream<Reducer> = mousePos$.map((e: MouseEvent) => (state: AppState): AppState => {
    const {config: {tile_info: [{width, height}]}} = state.tileset
    return {...state, mouseX: e ? (e.offsetX / width)|0 : null, mouseY: e ? (e.offsetY / height)|0 : null};
  })

  const selectTerrain$: Stream<Reducer> = DOM.select('.terrain').events('change').map(e => (state: AppState): AppState => {
    return {...state, selectedSymbolId: e.target.symbolId};
  })

  const editSymbol$: Stream<Reducer> = DOM.select('.editSymbol').events('click').map(e => (state: AppState): AppState => {
    const editType = e.target.editType as "fill_ter" | "terrain" | "furniture";
    const editingType = editType === 'fill_ter' ? 'terrain' : editType;
    const defn = state.mapgen.object[editingType];
    return {...state, editing: {
      type: editType,
      search: editType === 'fill_ter' ? state.mapgen.object.fill_ter : defn[state.selectedSymbolId],
      selectedIdx: 0
    }}
  });

  const removeSymbol$: Stream<Reducer> = DOM.select('.removeSymbol').events('click').map(e => (state: AppState): AppState => {
    const removeType: "terrain" | "furniture" = e.target.removeType;
    return {...state,
      mapgen: {...state.mapgen, object: {...state.mapgen.object, [removeType]: {...state.mapgen.object[removeType], [state.selectedSymbolId]: undefined}}},
    };
  });

  const updateSymbol$: Stream<Reducer> = choose.map(chosenId => (state: AppState): AppState => {
    if (chosenId == null) return {...state, editing: null};
    if (state.editing.type === 'fill_ter')
      return {...state, mapgen: {...state.mapgen, object: {...state.mapgen.object, fill_ter: chosenId}}, editing: null}
    return {...state,
      editing: null,
      mapgen: {...state.mapgen, object: {...state.mapgen.object, [state.editing.type]: {...state.mapgen.object[state.editing.type], [state.selectedSymbolId]: chosenId}}},
    };
  });

  const drawTerrain$: Stream<Reducer> = DOM.select('canvas.mapgen').events('mousedown').map((e: MouseEvent) => (state: AppState): AppState => {
    const rows = [...state.mapgen.object.rows];
    const {config: {tile_info: [{width, height}]}} = state.tileset
    const tx = (e.offsetX/width)|0, ty = (e.offsetY/height)|0;
    let row = rows[ty];
    row = row.substring(0, tx) + state.selectedSymbolId + row.substring(tx+1)
    rows[ty] = row
    return {...state, mapgen: {...state.mapgen, object: {...state.mapgen.object, rows}}}
  })

  const keys$: Stream<Reducer> = DOM.select('document').events('keydown').map((e: KeyboardEvent) => (state: AppState): AppState => {
    if (e.key in (state.mapgen.object.terrain || {}) || e.key == ' ')
      return {...state, selectedSymbolId: e.key};
    return state;
  })

  const addSymbol$: Stream<Reducer> = DOM.select('.addSymbol').events('click').map(e => (state: AppState): AppState => {
    return {...state}
  })

  const changeTab$: Stream<Reducer> = DOM.select('.tab').events('click').map((e: MouseEvent) => (state: AppState): AppState => {
    const target = e.target as HTMLElement
    return {...state, paletteTab: target.getAttribute("data-tab") as TabName}
  })

  return xs.merge(
    init$,
    selectRoot$,
    mouseTilePos$,
    selectTerrain$,
    drawTerrain$,
    keys$,
    editSymbol$,
    updateSymbol$,
    removeSymbol$,
    changeTab$,
  );
}

function view(state$: Stream<AppState>, modalVdom$: Stream<VNode | null>): Stream<VNode>
{
  return xs.combine(state$, modalVdom$.startWith(null))
    .map(([state, modalVdom]) => {
      return <div>
        {state.cddaRoot == null
          ? <button className='selectRoot'>Select CDDA root</button>
          : renderMain(state)}
        {state.editing != null ? modalVdom : null}
      </div>
    });
}


const terrainListStyle = {
  display: 'flex',
  flexDirection: 'row',
  flexWrap: 'wrap',
  margin: '0',
  padding: '0',
  listStyle: 'none',
};

function renderTerrainButton(cddaData: any, tileset: any, symbolId: string, terrainId: string, furnitureId: string | null, selected: boolean) {
  return <label>
    {input('.terrain', {attrs: {type: 'radio'}, props: {checked: selected, symbolId}, style: {display: 'none'}})}
    {renderTile(cddaData, tileset, {terrainId, furnitureId, background: selected ? 'red' : 'black'})}
  </label>;
}

function within(x: number, y: number, xrange: Array<number> | number, yrange: Array<number> | number) {
  const [xLo, xHi] = Array.isArray(xrange) ? [Math.min.apply(null, xrange), Math.max.apply(null, xrange)] : [xrange, xrange];
  const [yLo, yHi] = Array.isArray(yrange) ? [Math.min.apply(null, yrange), Math.max.apply(null, yrange)] : [yrange, yrange];
  return x >= xLo && x <= xHi && y >= yLo && y <= yHi;
}

function renderMain(state: AppState) {
  const {cddaData, mapgen, mouseX, mouseY, tileset, selectedSymbolId} = state;
  const hovered = mouseX != null && mouseY != null ?
    {
      terrain: mapgen.object.terrain[mapgen.object.rows[mouseY][mouseX]] || mapgen.object.fill_ter,
      furniture: mapgen.object.furniture[mapgen.object.rows[mouseY][mouseX]],
      loot: (mapgen.object.place_loot || []).filter((loot: PlaceLoot) => within(mouseX, mouseY, loot.x, loot.y))[0],
    } : null;
  const describeHovered = ({terrain, furniture, loot}: any) => {
    const ter = cddaData.terrain[terrain];
    const fur = cddaData.furniture[furniture];
    const loo = loot ? ` (${loot.chance}% ${loot.group}${loot.repeat ? ' ' + loot.repeat.join('-') : ''})` : '';
    return `${ter.name}${fur ? ` / ${fur.name}` : ''}${loo}`;
  };
  return <div>
    <div style={{display: 'flex', flexDirection: 'row'}}>
      <div>{renderMapgen(cddaData, mapgen, tileset, {mouseX, mouseY})}</div>
      <div style={{marginLeft: `${tileset.config.tile_info[0].width}px`}}>
        <div style={{height: '32px', overflow: 'hidden', textOverflow: 'ellipsis'}}>
          Hovered: {hovered ? describeHovered(hovered) : 'none'}
        </div>
        <ul className={Styles.tabs} style={terrainListStyle}>
          {["map", "zone"].map(tabName => {
            const selected = tabName === state.paletteTab;
            return dom.li('.tab',
              {class: {selected},
               attrs: {'data-tab': tabName}},
              [tabName]
            );
          })}
        </ul>
        {TABS[state.paletteTab](state)}
      </div>
    </div>
  </div>
}

const TABS: Record<TabName, (state: AppState) => VNode> = {
  map: (state: AppState): VNode => {
    const {cddaData, mapgen, mouseX, mouseY, tileset, selectedSymbolId} = state;
    const terrains = Object.keys(mapgen.object.terrain);
    const selectedTerrain = selectedSymbolId === ' ' ? { terrain: mapgen.object.fill_ter, furniture: null } : {
      terrain: mapgen.object.terrain[selectedSymbolId],
      furniture: mapgen.object.furniture[selectedSymbolId],
    };
    return <div>
      <ul className="symbols" style={terrainListStyle}>
        <li>{renderTerrainButton(cddaData, tileset, ' ', mapgen.object.fill_ter, null, selectedSymbolId === ' ')}</li>
        {terrains.map(tId =>
          <li>{renderTerrainButton(cddaData, tileset, tId, mapgen.object.terrain[tId], mapgen.object.furniture[tId], selectedSymbolId === tId)}</li>
        )}
      </ul>
      <button className='addSymbol'>add symbol</button>
      {selectedSymbolId !== ' '
      ? <div className="brushProps">
          <div>Terrain: {dom.a('.editSymbol', {attrs: {href: '#'}, props: {editType: 'terrain'}}, [selectedTerrain.terrain])}</div>
          <div>Furniture: {
            selectedTerrain.furniture
            ? dom.span([
                dom.a('.editSymbol', {attrs: {href: '#'}, props: {editType: 'furniture'}}, [selectedTerrain.furniture]),
                " ",
                dom.a('.removeSymbol', {attrs: {href: '#'}, props: {removeType: 'furniture'}}, ['x'])
              ])
            : dom.span([
                dom.a('.editSymbol', {attrs: {href: '#'}, props: {editType: 'furniture'}}, ['+'])
            ])}</div>
        </div>
        : <div>
          Base terrain: {dom.a('.editSymbol', {attrs: {href: '#'}, props: {editType: 'fill_ter'}}, [mapgen.object.fill_ter])}
        </div>}
    </div>;
  },
  "zone": (state: AppState): VNode => {
    return <div>
    region stuff
    </div>;
  },
}

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

function determineWallCorner(cddaData: any, obj: any, [tx, ty]: [number, number]) {
  const terrainIdAt = (x: number, y: number): string => (y in obj.rows && x >= 0 && x < obj.rows[y].length && obj.rows[y][x] in obj.terrain) ? obj.terrain[obj.rows[y][x]] : obj.fill_ter;
  const connectGroup = (ter: any): string => ter.connects_to || (ter.flags.indexOf("WALL") >= 0 || ter.flags.indexOf("CONNECT_TO_WALL") >= 0 ? "WALL" : null);
  const terId = terrainIdAt(tx, ty);
  const ter = cddaData.terrain[terId];
  const connectedLeft = connectGroup(cddaData.terrain[terrainIdAt(tx - 1, ty)]) === connectGroup(ter) ? 1 : 0;
  const connectedUp = connectGroup(cddaData.terrain[terrainIdAt(tx, ty - 1)]) === connectGroup(ter) ? 1 : 0;
  const connectedRight = connectGroup(cddaData.terrain[terrainIdAt(tx + 1, ty)]) === connectGroup(ter) ? 1 : 0;
  const connectedDown = connectGroup(cddaData.terrain[terrainIdAt(tx, ty + 1)]) === connectGroup(ter) ? 1 : 0;
  const dirId = (connectedLeft << 3) | (connectedUp << 2) | (connectedRight << 1) | (connectedDown);
  return WALL_SYMS.get(dirId).charAt(0)
}

function renderMapgen(cddaData: any, mapgen: any, tileset: any, {mouseX, mouseY}: {mouseX: number | null, mouseY: number | null}) {
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

  function drawTile(ctx: CanvasRenderingContext2D, img: HTMLImageElement, offset: number, x: number, y: number) {
    const ix = offset % tilesPerRow, iy = Math.floor(offset / tilesPerRow);
    ctx.drawImage(img, ix * tileWidth, iy * tileHeight, tileWidth, tileHeight, x * tileWidth, y * tileHeight, tileWidth, tileHeight)
  }

  function getSymbolFor(x: number, y: number) {
    const char = mapgen.object.rows[y][x];
    if (mapgen.object.furniture[char] != null) {
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

  function draw(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = "black"
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const {symbol, color} = getSymbolFor(x, y);
        const asciiColor = mapColor(color)
        const asciiOffset = asciiMap.get(asciiColor);

        drawTile(ctx, tileImage, asciiOffset + symbol.codePointAt(0), x, y)
      }
    (mapgen.object.place_items || []).forEach((item: any) => {
    });
    (mapgen.object.place_loot || []).forEach((loot: PlaceLoot) => {
      const {group, x, y, chance, repeat} = loot;
      const [xLo, xHi] = Array.isArray(x) ? [Math.min.apply(null, x), Math.max.apply(null, x)] : [x, x];
      const [yLo, yHi] = Array.isArray(y) ? [Math.min.apply(null, y), Math.max.apply(null, y)] : [y, y];
      ctx.strokeStyle = "orange"
      ctx.lineWidth = 1
      ctx.strokeRect(tileWidth * xLo + 0.5, tileWidth * yLo + 0.5, tileWidth * (xHi - xLo + 1) - 1, tileHeight * (yHi - yLo + 1) - 1);
    });
    if (mouseX != null && mouseY != null) {
      ctx.strokeStyle = "red"
      ctx.lineWidth = 4
      ctx.strokeRect(tileWidth * mouseX, tileHeight * mouseY, tileWidth, tileHeight)
    }
  }

  return canvas('.mapgen',
    {
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

function renderTile(cddaData: any, tileset: any, {terrainId, furnitureId, background}: any) {
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

  function getSymbolFor(terrainId: string, furnitureId: string) {
    if (furnitureId != null) {
      const furniture = cddaData.furniture[furnitureId];
      return {symbol: furniture.symbol, color: furniture.color || ""};
    }
    const oneTerrainId = Array.isArray(terrainId) ? terrainId[0] : terrainId;
    const {symbol, color, flags} = cddaData.terrain[oneTerrainId]
    const isAutoWall = flags && flags.indexOf("AUTO_WALL_SYMBOL") >= 0;
    const oneColor = Array.isArray(color) ? color[0] : color;
    const sym = isAutoWall ? WALL_SYMS.get(0) : symbol;
    return {symbol: sym, color: oneColor};
  }

  function drawTile(ctx: CanvasRenderingContext2D, img: HTMLImageElement, offset: number, x: number, y: number) {
    const ix = offset % tilesPerRow, iy = Math.floor(offset / tilesPerRow);
    ctx.drawImage(img, ix * tileWidth, iy * tileHeight, tileWidth, tileHeight, x * tileWidth, y * tileHeight, tileWidth, tileHeight)
  }


  function draw(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    const {symbol, color} = getSymbolFor(terrainId, furnitureId);
    const asciiColor = mapColor(color)
    const asciiOffset = asciiMap.get(asciiColor);

    drawTile(ctx, tileImage, asciiOffset + symbol.codePointAt(0), 0, 0)
  }

  return canvas(
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
    case "": return "WHITE-false"
    default: console.error(`missing fg ${color}`); return "WHITE-false"
  }
}
