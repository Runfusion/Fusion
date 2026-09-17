---
"@runfusion/fusion": patch
---

summary: Fiabilise les champs mobiles quand le clavier s'ouvre, sans espace vide ni champ masqué.
category: fix
dev: FN-512 centralise la mesure du viewport clavier dans `app/utils/mobileKeyboardViewport.ts` (instantané atomique géométrie + focus, abonnement partagé unique, inset résiduel `max(0, layoutHeight - visibleBottom)` nul quand le layout a déjà été réduit). `useMobileKeyboard` devient une façade séparant détection heuristique et placement géométrique ; `useKeyboardViewportSurface` borne un conteneur depuis son propre rectangle mesuré et publie la propriété par contexte, si bien que `MobileDrawer`, `FloatingWindow` et `TerminalModal` sont les seuls adaptateurs et que Chat, formulaires et terminaux n'appliquent plus de seconde compensation. Retraits sans perte de fonction utilisateur : la marge iOS constante `--chat-keyboard-accessory-clearance`, le `translateY(offsetTop)` sur `.chat-thread`, les délais 350/450/1500 ms et les relevés par consommateur, et les assistances `scrollIntoView({block:"center"})` qui déplaçaient le document, remplacées par `scrollFocusedControlWithin` borné au scroller du champ focalisé.
