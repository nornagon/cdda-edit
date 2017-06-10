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
}

export default Styles;
