import xs, { Stream } from 'xstream';
import sampleCombine from 'xstream/extra/sampleCombine';
import concat from 'xstream/extra/concat';
import { VNode, DOMSource } from '@cycle/dom';
import * as dom from '@cycle/dom';
import isolate from '@cycle/isolate';
import { StateSource } from 'cycle-onionify';

import { Sources, Sinks } from './interfaces';
import {IdSelector, Sinks as IdSelectorSinks} from './IdSelector';
import Styles from './styles';
import {CddaData, Mapgen, MapgenObject, PlaceLoot, PlaceMonsters, loadCDDAData} from './CddaData';

import {AppSources, AppSinks, Reducer, AppState} from './app';
import {renderTile} from './Rendering';

export function SymbolsTab(sources: AppSources): AppSinks {
  const {DOM} = sources;

  const selectSymbol$: Stream<Reducer> = DOM.select('.terrain')
    .events('change')
    .map(e => (state: AppState): AppState =>
      ({...state, selectedSymbolId: (e.target as any).symbolId}))

  const SYMBOLS = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ");
  const addSymbol$: Stream<Reducer> = DOM.select('.addSymbol')
    .events('click')
    .map(e => (state: AppState): AppState => {
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
  const removeSymbol$: Stream<Reducer> = DOM.select('.removeSymbol')
    .events('click')
    .map(e => (state: AppState): AppState => {
      const {selectedSymbolId} = state;
      const {[selectedSymbolId]: _, ...newTerrain} = state.mapgen.object.terrain;
      const {[selectedSymbolId]: __, ...newFurniture} = state.mapgen.object.furniture;
      return {...state,
        selectedSymbolId: ' ',
        mapgen: {...state.mapgen,
          object: {...state.mapgen.object,
            terrain: newTerrain,
            furniture: newFurniture,
            rows: state.mapgen.object.rows.map(row => row.split(selectedSymbolId).join(' '))
          }
        }
      }
    })

  const removeSymbolProperty$: Stream<Reducer> = DOM.select('.removeSymbolProperty')
    .events('click')
    .map(e => (state: AppState): AppState => {
      const removeType: 'furniture' = (e.target as any).removeType;
      return {...state,
        mapgen: {...state.mapgen, object: {...state.mapgen.object, [removeType]: {...state.mapgen.object[removeType], [state.selectedSymbolId]: undefined}}},
      };
    });

  const symbol$ = sources.onion.state$.map(state => {
    const {selectedSymbolId: symbol, mapgen: {object}} = state;
    return {
      symbol,
      terrain: symbol === ' ' ? object.fill_ter : object.terrain[symbol] as string,
      furniture: symbol === ' ' ? null : object.furniture[symbol] as string,
    }
  });

  const chooseRequest$ = DOM.select('.editSymbol')
    .events('click')
    .map(e => (e.target as any).editType as 'fill_ter' | 'terrain' | 'furniture')
    .compose(sampleCombine(symbol$))
    .map(([editType, symbol]) => {
      const type = editType === 'fill_ter' ? 'terrain' : editType;
      return {
        type,
        symbol,
        search: symbol[type],
      };
    });

  const selector$ = chooseRequest$.compose(sampleCombine(sources.onion.state$)).map(([req, state]) => {
    return isolate(IdSelector(state.cddaData, req.type, req.search || '', state.cddaData[req.type]), 'editing')(sources);
  }) as Stream<IdSelectorSinks>;
  const selectorDom$ = selector$.map(s => concat(s.DOM.endWhen(s.choose), xs.of(null))).flatten().startWith(null)
  const selectorReducers$ = selector$.map(s => s.onion).flatten()

  const editSymbol$ = selector$.map(s => s.choose).flatten().compose(sampleCombine(chooseRequest$)).map(([chosen, request]) => {
    return (state: AppState): AppState => {
      if (chosen == null) return state;
      if (request.symbol.symbol === ' ') {
        return {...state, mapgen: {...state.mapgen, object: {...state.mapgen.object, fill_ter: chosen}}, editing: null};
      } else {
        return {...state, editing: null, mapgen: {...state.mapgen, object: {...state.mapgen.object,
          [request.type]: {...state.mapgen.object[request.type],
            [request.symbol.symbol]: chosen
          }
        }}};
      }
    }
  })

  return {
    DOM: xs.combine(sources.onion.state$.map(SymbolsTabView), selectorDom$).map((doms) => <span>{doms}</span>),
    onion: xs.merge(selectSymbol$, addSymbol$, removeSymbol$, removeSymbolProperty$, editSymbol$, selectorReducers$),
  };
}

function SymbolsTabView(state: AppState): VNode {
  const {cddaData, mapgen, mouseX, mouseY, tileset, selectedSymbolId} = state;
  const terrains = Object.keys(mapgen.object.terrain);
  const selectedTerrain = selectedSymbolId === ' ' ? { terrain: mapgen.object.fill_ter, furniture: null } : {
    terrain: mapgen.object.terrain[selectedSymbolId],
    furniture: mapgen.object.furniture[selectedSymbolId],
  };
  return <div>
    <ul className={`symbols ${Styles.terrainList}`}>
      <li>{renderTerrainButton(cddaData, tileset, ' ', mapgen.object.fill_ter, null, selectedSymbolId === ' ')}</li>
      {terrains.map(tId =>
        <li>{renderTerrainButton(cddaData, tileset, tId, mapgen.object.terrain[tId], mapgen.object.furniture[tId], selectedSymbolId === tId)}</li>
      )}
    </ul>
    <button className='addSymbol'>add symbol</button>
    {selectedSymbolId !== ' '
    ? <div className="brushProps">
        <div>Terrain: {dom.button('.editSymbol.selector', {props: {editType: 'terrain'}}, [selectedTerrain.terrain])}</div>
        <div>Furniture: {
          selectedTerrain.furniture
          ? dom.span([
              dom.button('.editSymbol.selector', {props: {editType: 'furniture'}}, [selectedTerrain.furniture]),
              " ",
              dom.button('.removeSymbolProperty', {props: {removeType: 'furniture'}}, ['x'])
            ])
          : dom.span([
              dom.button('.editSymbol.selector', {props: {editType: 'furniture'}}, ['+'])
          ])}
        </div>
        <div>
          <br/><br/><br/>
          {dom.button('.removeSymbol', ['delete symbol'])}
        </div>
      </div>
      : <div>
        Base terrain: {dom.button('.editSymbol.selector', {props: {editType: 'fill_ter'}}, [mapgen.object.fill_ter])}
      </div>}
  </div>;
}

function renderTerrainButton(cddaData: any, tileset: any, symbolId: string, terrainId: string, furnitureId: string | null, selected: boolean) {
  return <label style={{cursor: 'pointer'}}>
    {dom.input('.terrain', {attrs: {type: 'radio'}, props: {checked: selected, symbolId}, style: {display: 'none'}})}
    {dom.thunk('canvas.terrainButton', symbolId, renderTile, [cddaData, tileset, terrainId, furnitureId, selected])}
  </label>;
}
