import {style} from "typestyle";

namespace Styles {
  export const tabs = style({
    listStyle: 'none',
    $nest: {
      "&>li": {
        cursor: "pointer",
        userSelect: "none",
        $nest: {
          "&.selected": { background: "white", color: "black" }
        },
        marginRight: "1ex",
      }
    }
  })

  export const terrainList = style({
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'wrap',
    margin: 0,
    padding: 0,
    listStyle: 'none',
  })
}

export default Styles;
