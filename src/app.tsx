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
import * as bresenham from 'bresenham';

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
  place_monsters?: Array<PlaceMonsters>;
}
type PlaceLoot = any;
type PlaceMonsters = any;
type ZoneOptions = LootZoneOptions | MonstersZoneOptions;
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
  zoneOptions: ZoneOptions;
};
interface LootZoneOptions {
  type: "loot";
  groupId: string;
  chance: number;
  repeat: number;
};
interface MonstersZoneOptions {
  type: "monsters";
  groupId: string;
  chance: number;
  repeat: number;
};

interface CddaData {
  objects: Array<any>;
  terrain: {[id: string]: any};
  furniture: {[id: string]: any};
  tilesets: any;
  item_group: {[id: string]: any};
  monstergroup: {[id: string]: any};
}

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


function loadCDDAData(root: string): CddaData {
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
  const item_group: {[id: string]: any} = {};
  objects.filter((o: any) => o.type === 'item_group').forEach((t: any) => item_group[t.id] = t);
  const monstergroup: {[id: string]: any} = {};
  objects.filter((o: any) => o.type === 'monstergroup').forEach((t: any) => monstergroup[t.name] = t);

  return {objects, terrain, furniture, tilesets, item_group, monstergroup};
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

function intent(DOM : DOMSource, electro, choose: Stream<string>) : Stream<Reducer> {
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
      zoneOptions: {
        type: "loot",
        groupId: "everyday_gear",
        chance: 100,
        repeat: 1,
      }
    }
  });

  const selectRoot$: Stream<Reducer> = electro.map(e => (state: AppState): AppState => {
    return ({...state, cddaRoot: e[0], cddaData: loadCDDAData(e[0])})
  })

  const mousePos$ = xs.merge(DOM.select('canvas.mapgen').events('mousemove'), DOM.select('canvas.mapgen').events('mouseout').map(e => null));

  const mouseTilePos$: Stream<Reducer> = mousePos$.map((e: MouseEvent) => (state: AppState): AppState => {
    const {config: {tile_info: [{width, height}]}} = state.tileset
    const mouseX = e ? (e.offsetX / width)|0 : null;
    const mouseY = e ? (e.offsetY / height)|0 : null;
    return {...state, mouseX, mouseY};
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

  const removeSymbolProperty$: Stream<Reducer> = DOM.select('.removeSymbolProperty').events('click').map(e => (state: AppState): AppState => {
    const removeType: 'furniture' = e.target.removeType;
    return {...state,
      mapgen: {...state.mapgen, object: {...state.mapgen.object, [removeType]: {...state.mapgen.object[removeType], [state.selectedSymbolId]: undefined}}},
    };
  });

  const updateSymbol$: Stream<Reducer> = choose.map(chosenId => (state: AppState): AppState => {
    if (chosenId == null) return {...state, editing: null};
    switch (state.editing.type) {
      case 'fill_ter':
        return {...state, mapgen: {...state.mapgen, object: {...state.mapgen.object, fill_ter: chosenId}}, editing: null}

      case 'terrain': // fallthrough
      case 'furniture':
        return {...state,
          editing: null,
          mapgen: {...state.mapgen,
            object: {...state.mapgen.object,
              [state.editing.type]: {...state.mapgen.object[state.editing.type],
                [state.selectedSymbolId]: chosenId}}},
        };
      case "item_group":
      case "monstergroup":
        return {...state,
          editing: null,
          zoneOptions: {...state.zoneOptions,
            groupId: chosenId
          }
        };
    }
  });

  const changeZoneType$: Stream<Reducer> = DOM.select('.zoneType').events('change').map(e => (state: AppState): AppState => {
    const select = e.target as HTMLSelectElement;
    const newZoneOptions = {
      loot: { type: 'loot', groupId: 'everyday_gear', chance: 100, repeat: 1 } as LootZoneOptions,
      monsters: { type: 'monsters', groupId: 'GROUP_ZOMBIE', chance: 1, repeat: 1 } as MonstersZoneOptions
    }[select.value as "loot" | "monsters"];
    return {...state, zoneOptions: newZoneOptions}
  })

  const editZoneGroup$: Stream<Reducer> = DOM.select('.zoneGroup').events('click').map(e => (state: AppState): AppState => {
    return {...state, editing: {
      type: {
        "loot": "item_group",
        "monsters": "monstergroup"
      }[state.zoneOptions.type],
      search: state.zoneOptions.groupId,
      selectedIdx: 0
    }};
  });

  const map = DOM.select('canvas.mapgen')
  const drags = map.events('mousedown').map(d =>
    map.events('mousemove')
      .startWith(d)
      .map(m => ({
        down: {x: d.offsetX, y: d.offsetY},
        current: {x: m.offsetX, y: m.offsetY}
      }))
      .endWhen(map.events('mouseup'))
  );
  const intermediateRects = drags.flatten()
  const rects = drags.map(s => s.last()).flatten()

  const positions = intermediateRects.map(e => e.current)
  const lines = xs.combine(positions, (positions.drop(1) as Stream<{x: number, y: number} | null>).startWith(null));

  const makeZone = (zo: ZoneOptions, xRange: [number, number], yRange: [number, number]): any => {
    switch (zo.type) {
      case 'loot':
        return {group: zo.groupId, chance: zo.chance, repeat: zo.repeat, x: xRange, y: yRange};
      case 'monsters':
        return {monster: zo.groupId, chance: zo.chance, repeat: zo.repeat, x: xRange, y: yRange};
    }
  }

  const drawZone$: Stream<Reducer> = rects.map(({down, current}) => (state: AppState): AppState => {
    if (state.paletteTab !== 'zone')
      return state;
    const {config: {tile_info: [{width, height}]}} = state.tileset;
    const downX = (down.x / width)|0;
    const downY = (down.y / height)|0;
    const curX = (current.x / width)|0;
    const curY = (current.y / height)|0;
    const zoneType = `place_${state.zoneOptions.type}` as 'place_loot' | 'place_monsters';
    return {...state,
      mapgen: {...state.mapgen,
        object: {...state.mapgen.object,
          [zoneType]: [...(state.mapgen.object[zoneType] || []), makeZone(state.zoneOptions, [downX, curX], [downY, curY])]
        }
      }
    };
  })

  const drawTerrain$: Stream<Reducer> = lines.map(([cur, prev]: [{x: number, y: number}, {x: number, y: number}]) => (state: AppState): AppState => {
    if (state.paletteTab !== 'map')
      return state;
    const {config: {tile_info: [{width, height}]}} = state.tileset
    // TODO: something something bresenham
    const rows = [...state.mapgen.object.rows];
    const tx = (cur.x/width)|0, ty = (cur.y/height)|0;
    if (rows[ty][tx] === state.selectedSymbolId)
      return state;
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

  const SYMBOLS = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ");
  const addSymbol$: Stream<Reducer> = DOM.select('.addSymbol').events('click').map(e => (state: AppState): AppState => {
    const existingSymbols = new Set(Object.keys(state.mapgen.object.terrain));
    const symbolToUse = [...SYMBOLS].find(x => !existingSymbols.has(x))
    if (symbolToUse == null) {
      alert("Oops! too many symbols")
      return state;
    }
    return {...state,
      mapgen: {...state.mapgen,
        object: {...state.mapgen.object,
          terrain: {...state.mapgen.object.terrain,
            [symbolToUse]: "t_rock_floor"
          }
        }
      },
      selectedSymbolId: symbolToUse
    };
  })
  const removeSymbol$: Stream<Reducer> = DOM.select('.removeSymbol').events('click').map(e => (state: AppState): AppState => {
    const {selectedSymbolId} = state;
    const {[selectedSymbolId]: _, ...newTerrain} = state.mapgen.object.terrain;
    const {[selectedSymbolId]: __, ...newFurniture} = state.mapgen.object.furniture;
    return {...state,
      selectedSymbolId: ' ',
      mapgen: {...state.mapgen,
        object: {...state.mapgen.object,
          terrain: newTerrain,
          furniture: newFurniture,
          rows: state.mapgen.object.rows.map(row => row.replace(selectedSymbolId, ' '))
        }
      }
    }
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
    drawZone$,
    keys$,
    editSymbol$,
    updateSymbol$,
    removeSymbolProperty$,
    changeTab$,
    editZoneGroup$,
    changeZoneType$,
    addSymbol$,
    removeSymbol$,
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
  return <label style={{cursor: 'pointer'}}>
    {input('.terrain', {attrs: {type: 'radio'}, props: {checked: selected, symbolId}, style: {display: 'none'}})}
    {dom.thunk('canvas', symbolId, renderTile, [cddaData, tileset, terrainId, furnitureId, selected ? 'red' : 'black'])}
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
    const loo = loot ? ` (${loot.chance}% ${loot.group}${loot.repeat ? ' ' + (Array.isArray(loot.repeat) ? loot.repeat.join('-') : loot.repeat) : ''})` : '';
    return `${ter.name}${fur ? ` / ${fur.name}` : ''}${loo}`;
  };
  return <div>
    <div style={{display: 'flex', flexDirection: 'row'}}>
      {dom.thunk('canvas.mapgen', renderMapgen, [cddaData, mapgen, tileset, mouseX, mouseY])}
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
                dom.a('.removeSymbolProperty', {attrs: {href: '#'}, props: {removeType: 'furniture'}}, ['x'])
              ])
            : dom.span([
                dom.a('.editSymbol', {attrs: {href: '#'}, props: {editType: 'furniture'}}, ['+'])
            ])}
          </div>
          <div>
            <br/><br/><br/>
            {dom.button('.removeSymbol', ['delete symbol'])}
          </div>
        </div>
        : <div>
          Base terrain: {dom.a('.editSymbol', {attrs: {href: '#'}, props: {editType: 'fill_ter'}}, [mapgen.object.fill_ter])}
        </div>}
    </div>;
  },

  zone: (state: AppState): VNode => {
    return <div>
      <div>
        Place:
        <select className="zoneType" value={state.zoneOptions.type}>
          <option>loot</option>
          <option>monsters</option>
        </select>
      </div>
      <div>
        Group: {dom.a('.zoneGroup', {attrs: {href: '#'}}, [state.zoneOptions.groupId])}
      </div>
      <div>
        Repeat: {dom.input('.zoneRepeat', {props: {value: state.zoneOptions.repeat}})}
      </div>
      <div>
        Chance: {dom.input('.zoneChance', {props: {value: state.zoneOptions.chance}})}
      </div>
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
  const connectGroup = (ter: any): string => ter.connects_to || ((ter.flags || []).indexOf("WALL") >= 0 || (ter.flags || []).indexOf("CONNECT_TO_WALL") >= 0 ? "WALL" : null);
  const terId = terrainIdAt(tx, ty);
  const ter = cddaData.terrain[terId];
  const connectedLeft = connectGroup(cddaData.terrain[terrainIdAt(tx - 1, ty)]) === connectGroup(ter) ? 1 : 0;
  const connectedUp = connectGroup(cddaData.terrain[terrainIdAt(tx, ty - 1)]) === connectGroup(ter) ? 1 : 0;
  const connectedRight = connectGroup(cddaData.terrain[terrainIdAt(tx + 1, ty)]) === connectGroup(ter) ? 1 : 0;
  const connectedDown = connectGroup(cddaData.terrain[terrainIdAt(tx, ty + 1)]) === connectGroup(ter) ? 1 : 0;
  const dirId = (connectedLeft << 3) | (connectedUp << 2) | (connectedRight << 1) | (connectedDown);
  return WALL_SYMS.get(dirId).charAt(0)
}

function renderMapgen(cddaData: any, mapgen: any, tileset: any, mouseX: number | null, mouseY: number | null) {
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

function renderTile(cddaData: any, tileset: any, terrainId: string, furnitureId: string, background: string) {
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
    case "black": return "BLACK-false"
    case "": return "WHITE-false"
    default: console.error(`missing fg ${color}`); return "WHITE-false"
  }
}
