import xs, { Stream } from 'xstream';
import { VNode, DOMSource, svg, canvas, input } from '@cycle/dom';
import * as dom from '@cycle/dom';
import isolate from '@cycle/isolate';
import { StateSource } from 'cycle-onionify';

import { Sources, Sinks } from './interfaces';
import {IdSelector} from './IdSelector';

import * as fs from 'fs';
import * as path from 'path';
import * as electron from 'electron';
import * as glob from 'glob';
import * as stringify from 'json-beautify';

export type AppSources = Sources & { onion : StateSource<AppState> };
export type AppSinks = Sinks & { onion : Stream<Reducer> };
export type Reducer = (prev : AppState) => AppState;
export type AppState = {
  count : number;
};

/**
 * source: --a--b----c----d---e-f--g----h---i--j-----
 * first:  -------F------------------F---------------
 * second: -----------------S-----------------S------
 *                         between
 * output: ----------c----d-------------h---i--------
 */
function between(first, second) {
  return (source) => first.mapTo(source.endWhen(second)).flatten()
}



function loadCDDAData(root: string): any {
  const filenames = glob.sync(root + '/data/json/**/*.json', {nodir: true});
  const objects = Array.prototype.concat.apply([], filenames.map(fn => {
    const json = JSON.parse(fs.readFileSync(fn))
    return (Array.isArray(json) ? json : [json]).map((x, i) => ({...x, _source: [fn, i]}));
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
    get: state => {
      const items = state.editing ?
        state.cddaData[state.editing.type === 'fill_ter' ? 'terrain' : state.editing.type] : {};
      return {
        ...state.editing,
        cddaData: state.cddaData,
        items
      }
    },
    set: (state, childState) => {
      const {cddaData: _, ...rest} = childState;
      return {...state, editing: rest}
    }
  };

  const {choose, ...selectorSinks} = isolate(IdSelector, {onion: selectorLens})(sources)

  const {onion: action$, electron: electronAction$} = intent(sources.DOM, sources.electron, choose);

  const vdom$ = view(sources.onion.state$.debug('state'), selectorSinks.DOM);

  return {
    DOM: vdom$,
    onion: xs.merge(action$, selectorSinks.onion),
    electron: xs.merge(selectRoot$, electronAction$),
  };
}

function intent(DOM : DOMSource, electro, choose) : Stream<Reducer>
{
  const init$ = xs.of(() => {
    const cddaRoot = "/Users/nornagon/Source/Cataclysm-DDA";
    const cddaData = loadCDDAData(cddaRoot);
    const tileset = cddaData.tilesets.find(x => /ChestHoleTileset/.test(x.root))
    electron.remote.getCurrentWindow().setContentSize(tileset.config.tile_info[0].width * (24 + 13), tileset.config.tile_info[0].height * 24)
    return {
      cddaRoot,
      cddaData,
      mapgen: cddaData.objects.filter(o => o.type === 'mapgen')[25],
      tileset,
      selectedSymbolId: " ",
    }
  });

  const selectRoot$ = electro.map(e => state => {
    return ({...state, cddaRoot: e[0], cddaData: loadCDDAData(e[0])})
  })

  const mousePos$ = xs.merge(DOM.select('canvas.mapgen').events('mousemove'), DOM.select('canvas.mapgen').events('mouseout').map(e => null));

  const mouseTilePos$ = mousePos$.map(e => state => {
    const {config: {tile_info: [{width, height}]}} = state.tileset
    return {...state, mouseX: e ? (e.offsetX / width)|0 : null, mouseY: e ? (e.offsetY / height)|0 : null};
  })

  const selectTerrain$ = DOM.select('.terrain').events('change').map(e => state => {
    return {...state, selectedSymbolId: e.target.symbolId};
  })

  const editSymbol$ = DOM.select('.editSymbol').events('click').map(e => state => {
    const editingType = e.target.editType === 'fill_ter' ? 'terrain' : e.target.editType;
    return {...state, editing: {
      type: e.target.editType,
      search: state.mapgen.object[editingType][state.selectedSymbolId],
      selectedIdx: 0
    }}
  });

  const removeSymbol$ = DOM.select('.removeSymbol').events('click').map(e => state => {
    const removeType = e.target.removeType;
    return {...state,
      mapgen: {...state.mapgen, object: {...state.mapgen.object, [removeType]: {...state.mapgen.object[removeType], [state.selectedSymbolId]: undefined}}},
    };
  });

  const updateSymbol$ = choose.map(chosenId => state => {
    if (chosenId == null) return {...state, editing: null};
    if (state.editing.type === 'fill_ter')
      return {...state, mapgen: {...state.mapgen, object: {...state.mapgen.object, fill_ter: chosenId}}, editing: null}
    return {...state,
      editing: null,
      mapgen: {...state.mapgen, object: {...state.mapgen.object, [state.editing.type]: {...state.mapgen.object[state.editing.type], [state.selectedSymbolId]: chosenId}}},
    };
  });

  const drawTerrain$ = DOM.select('canvas.mapgen').events('mousedown').map(e => state => {
    const rows = [...state.mapgen.object.rows];
    const {config: {tile_info: [{width, height}]}} = state.tileset
    const tx = (e.offsetX/width)|0, ty = (e.offsetY/height)|0;
    let row = rows[ty];
    row = row.substring(0, tx) + state.selectedSymbolId + row.substring(tx+1)
    rows[ty] = row
    return {...state, mapgen: {...state.mapgen, object: {...state.mapgen.object, rows}}}
  })

  const keys$ = DOM.select('document').events('keydown').map(e => state => {
    if (e.key in state.mapgen.object.terrain || e.key == ' ')
      return {...state, selectedSymbolId: e.key};
    return state;
  })

  const addSymbol$ = DOM.select('.addSymbol').events('click').map(e => state => {
    return {...state}
  })

  return {onion: xs.merge(init$, selectRoot$, mouseTilePos$, selectTerrain$, drawTerrain$, keys$, editSymbol$, updateSymbol$, removeSymbol$), electron: xs.empty()};
}

function view(state$ : Stream<AppState>, modalVdom$) : Stream<VNode>
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

function renderTerrainButton(cddaData, tileset, symbolId, terrainId, furnitureId, selected) {
  return <label>
    {input('.terrain', {attrs: {type: 'radio'}, props: {checked: selected, symbolId}, style: {display: 'none'}})}
    {renderTile(cddaData, tileset, {terrainId, furnitureId, background: selected ? 'red' : 'black'})}
  </label>;
}

function within(x, y, xrange, yrange) {
  const [xLo, xHi] = Array.isArray(xrange) ? [Math.min.apply(null, xrange), Math.max.apply(null, xrange)] : [xrange, xrange];
  const [yLo, yHi] = Array.isArray(yrange) ? [Math.min.apply(null, yrange), Math.max.apply(null, yrange)] : [yrange, yrange];
  return x >= xLo && x <= xHi && y >= yLo && y <= yHi;
}

function renderMain(state) {
  const {cddaData, mapgen, mouseX, mouseY, tileset, selectedSymbolId} = state;
  const terrains = Object.keys(mapgen.object.terrain);
  let hovered;
  if (mouseX != null) {
    hovered = {
      terrain: mapgen.object.terrain[mapgen.object.rows[mouseY][mouseX]] || mapgen.object.fill_ter,
      furniture: mapgen.object.furniture[mapgen.object.rows[mouseY][mouseX]],
      loot: mapgen.object.place_loot.filter(loot => within(mouseX, mouseY, loot.x, loot.y))[0],
    }
  }
  const selectedTerrain = selectedSymbolId === ' ' ? { terrain: mapgen.object.fill_ter } : {
    terrain: mapgen.object.terrain[selectedSymbolId],
    furniture: mapgen.object.furniture[selectedSymbolId],
  };
  const describeHovered = ({terrain, furniture, loot}) => {
    const ter = cddaData.terrain[terrain];
    const fur = cddaData.furniture[furniture];
    const loo = loot ? ` (${loot.chance}% ${loot.group}${loot.repeat ? ' ' + loot.repeat.join('-') : ''})` : '';
    return `${ter.name}${fur ? ` / ${fur.name}` : ''}${loo}`;
  };
  return <div>
    <div style={{display: 'flex', flexDirection: 'row'}}>
      <div>{renderMapgen(cddaData, mapgen, tileset, {mouseX: mouseX, mouseY: mouseY})}</div>
      <div style={{marginLeft: `${tileset.config.tile_info[0].width}px`}}>
        <div style={{height: '32px', overflow: 'hidden', textOverflow: 'ellipsis'}}>
          Hovered: {hovered ? describeHovered(hovered) : 'none'}
        </div>
        <div>Base terrain: {dom.a('.editSymbol', {attrs: {href: '#'}, props: {editType: 'fill_ter'}}, [mapgen.object.fill_ter])}</div>
        <ul className="symbols" style={terrainListStyle}>
          <li>{renderTerrainButton(cddaData, tileset, ' ', mapgen.object.fill_ter, undefined, selectedSymbolId === ' ')}</li>
          {terrains.map(tId =>
            <li>{renderTerrainButton(cddaData, tileset, tId, mapgen.object.terrain[tId], mapgen.object.furniture[tId], selectedSymbolId === tId)}</li>
          )}
        </ul>
        <button className='addSymbol'>add symbol</button>
        {selectedSymbolId !== ' ' ?
            <div className="brushProps">
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
          </div> : null}
      </div>
    </div>
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
  const fallback = config['tiles-new'].find(x => x.ascii != null)
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

  function getSymbolFor(x, y) {
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
    (mapgen.object.place_items || []).forEach(item => {
    });
    (mapgen.object.place_loot || []).forEach(loot => {
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

  return canvas(
    '.mapgen',
    {attrs: {width: width * tileWidth, height: height * tileHeight}, hook: {insert: ({elm}) => draw(elm.getContext('2d')), update: ({elm}) => draw(elm.getContext('2d'))}}
  )
}

function renderTile(cddaData, tileset, {terrainId, furnitureId, background}) {
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

  function getSymbolFor(terrainId, furnitureId) {
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

  function drawTile(ctx, img, offset, x, y) {
    const ix = offset % tilesPerRow, iy = Math.floor(offset / tilesPerRow);
    ctx.drawImage(img, ix * tileWidth, iy * tileHeight, tileWidth, tileHeight, x * tileWidth, y * tileHeight, tileWidth, tileHeight)
  }


  function draw(ctx) {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    const {symbol, color} = getSymbolFor(terrainId, furnitureId);
    const asciiColor = mapColor(color)
    const asciiOffset = asciiMap.get(asciiColor);

    drawTile(ctx, tileImage, asciiOffset + symbol.codePointAt(0), 0, 0)
  }

  return canvas(
    {attrs: {width: tileWidth, height: tileHeight}, hook: {insert: ({elm}) => draw(elm.getContext('2d')), update: ({elm}) => draw(elm.getContext('2d'))}}
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
