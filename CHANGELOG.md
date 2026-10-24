# Changelog

## 0.6.0 — 2026-10-24

### Añadido
- `inharness board`/`dashboard`: tablero de cuatro pantallas con plan por
  oleadas, agentes, procesos CLI, proveedores, actividad y seguimiento de logs.
- `inharness report`: registro agnóstico y atómico de agentes y subagentes en
  `.inharness/agents/`.
- Modo `--open` para una pestaña de Windows Terminal; `--once`, `--json`,
  `--ascii` y `--no-color` para uso no interactivo.

## 0.5.0 — 2026-10-24

### Añadido
- `inharness status` y `inharness watch`: panel de filas delegadas, progreso,
  última salida y nota `now.md`, con salida JSON, ASCII y modo de refresco.
- El protocolo de las skills exige actualizar `now.md` por fase y mantener
  una fila por tarea en `assignment.md`.

## 0.4.1 — 2026-10-18

Las filas delegadas vuelven a verse en Windows Terminal.

### Corregido
- Skills: regla dura de lanzar las filas solo con `runRow.js launch` (nunca `codex exec`/`kimi -p` crudos ni en segundo plano); se quitan los ejemplos que inducían la invocación cruda.
- Guard: en texto libre, toda fila con id sin "hecho"/"fallido" cuenta como activa; busca `assignment.md` en carpetas padre y en destinos de `cd`/`-C`; mencionar runRow ya no exime; el hook de Claude cubre también la herramienta PowerShell.
- Fuera de Windows Terminal las filas se abren en una ventana propia `inharness` en vez de una ventana WT cualquiera.
- `launch` espera a que la pestaña arranque (código 1 si no); el fallback sin ventana ya no es silencioso (`visible:false`, `warning` y aviso en stderr).
- `syncSkills` compara el contenido completo: los cambios de texto llegan aunque no cambie la versión.

## 0.4.0 — 2026-10-18

Revisión thermo-nuclear de todo el proyecto. **Cambios incompatibles:** el log ya
no termina en `###INHARNESS_EXIT###` (el resultado va en `<log>.exit`) y las
skills usan `runRow.js` en lugar de recetas de shell.

### Seguridad
- Cierra la inyección por cmd.exe (`; & % "`, saltos de línea, límite 8191): los
  shims npm se ejecutan como node directo; el resto de `.cmd` con escape y fallo cerrado.
- `resolveExecutable` ya no busca en el cwd (binario plantado).
- Parámetros de `wt.exe` por fichero temporal 0600 de un solo uso; `logFile`
  confinado a `cwd` (sin junctions/symlinks hacia fuera); ids validados.
- Rutas de hooks escapadas para HOME con `$` o comillas; escrituras atómicas con
  backup `settings.json.bak-inharness`.

### Fiabilidad
- El guard también reconoce repartos en texto libre (filas `F2 ... en curso`) y no solo tablas con columna `estado`.
- Resultado fuera de banda (`.exit`, `.pid`); `EBUSY` si el log tiene ejecución
  viva (también en fallback concurrente); timeouts, kill de árbol y salida grande íntegra.
- Runtime estable en `~/.inharness/runtime`; hooks migrados desde rutas antiguas;
  arranque tolerante a fallos (`safeStartup`); hooks caducan a las 12 h y fallan abiertos.
- `handoff` reescrito sobre `buildSpawn`.

### Añadido
- `src/runRow.js` (`launch|wait|status`) y skills de Claude/Codex/Kimi reescritas.
- `npm test` (77 tests; 3 dependen de plataforma o de `INHARNESS_LIVE_WT=1`); `.gitignore`; autoignore de `.inharness/`.
- Variables: `INHARNESS_FORCE_FALLBACK`, `INHARNESS_ALLOW_RAW`, `INHARNESS_NO_GUARDRAILS`,
  `INHARNESS_STALE_HOURS`, `INHARNESS_PANE_LINGER_MS`, `INHARNESS_LIVE_WT` (tests).

### Limitaciones conocidas
- Hook de Codex *untrusted* hasta confirmarlo en `/hooks`; Kimi sin hooks.
- Solo verificado en Windows; Linux/macOS usan fallback.
- Un `.cmd`/`.bat` que no es shim npm ni de binario nativo va por cmd.exe (rechaza `%` y saltos de línea).

## 0.3.2 — 2026-10-18

### Añadido
- **Guardarraíl técnico contra invocación cruda de Codex/Kimi (no una regla
  de prompt).** Una skill puede decir "usa paneLauncher" todo lo que quiera
  — un orquestador LLM puede simplemente no seguirlo (pasó en esta misma
  sesión de desarrollo). Nuevo `src/installGuardrails.js`, llamado desde
  `bin/inharness.js` en cada arranque (idempotente): instala un hook
  `PreToolUse` real en `~/.claude/settings.json` (Claude Code) y en
  `~/.codex/hooks.json` (Codex, matcher `^Bash$`) que bloquea la llamada
  Bash cruda si hay una fila activa en `.inharness/assignment.md`. Ambos
  verificados en vivo contra el runtime real (Claude: bloqueo inmediato sin
  reinicio; Codex: 8 aserciones contra su app-server real, ver
  `.inharness/codex-hooks-investigation/REPORT.md` de la auditoría que lo
  produjo). Lógica de detección compartida en `src/guardLogic.js`
  (`src/claudeGuardHook.js` y `src/codexPreToolUse.cjs`), para que las dos
  implementaciones no diverjan.
  - Codex marca un hook nuevo como *untrusted* hasta que el usuario lo
    confirma en `/hooks` — puerta de seguridad propia de Codex, no evitable.
  - Kimi Code no tiene mecanismo de hooks hoy: sin guardarraíl técnico ahí,
    solo la regla de prompt en su skill.
- **Catálogo persistente de CLIs/modelos.** Nuevo `src/catalogCache.js`
  (`writeCatalog`/`readCatalog`). `bin/inharness.js` escribe el resultado de
  cada descubrimiento en `~/.inharness/catalog.json` (global, no por
  proyecto) como punto de arranque rápido para las skills. Falla en
  silencio (solo `console.warn`) si no se puede escribir.

## 0.3.1 — 2026-10-18

### Cambiado
- **Paso 2 de las tres skills: buscar paralelismo real antes de resolver en
  una sola fila.** Hasta ahora, "no inflar piezas para una tarea trivial"
  se usaba como excusa para despachar tareas con ángulos genuinamente
  independientes (p. ej. seguridad / portabilidad / consistencia de docs en
  una auditoría) a un único CLI en serie, incluso cuando el propio CLI
  director podía quedarse con uno de esos ángulos. Ahora el Paso 2 pide
  comprobar activamente si hay ángulos independientes — incluido el propio
  director, resolviéndolos inline (Claude: vía `Agent`; Codex/Kimi: en la
  misma sesión, sin anidar otro proceso) — antes de conformarse con una sola
  fila. La regla de no inflar tareas triviales se mantiene intacta para
  cuando de verdad no hay nada que paralelizar.

## 0.3.0 — 2026-10-18

### Añadido
- **Visibilidad en vivo del trabajo delegado (Windows Terminal).** Nuevo
  `src/paneLauncher.js` con cuatro exports: `launchInPane`,
  `waitForCompletion`, `hasWindowsTerminal` e `insideWindowsTerminal`.
  `launchInPane` decide el modo en este orden: `pane` (`wt.exe split-pane`)
  si la sesión ya corre dentro de Windows Terminal (`WT_SESSION`), `tab`
  (`wt.exe new-tab`) si hay `wt.exe` en el PATH aunque no estemos dentro, y
  `fallback` (la ejecución invisible y síncrona de siempre vía `spawnCli`) si
  no hay Windows Terminal — una caída esperada, nunca un error. En pane/tab
  el proceso lanza `wt.exe` detached, no bloquea al orquestador y queda
  visible mientras corre; su stdout+stderr combinado se vuelca al log
  habitual cerrando con la línea sentinel `###INHARNESS_EXIT:<código>###`,
  que `waitForCompletion` sondea (por defecto cada 1 s, hasta 10 min) para
  devolver `ok`/`exitCode`/`output` o `timedOut`. En fallback el log queda en
  el mismo formato, así que el resto del flujo no nota la diferencia. El
  usuario no invoca nada: la apertura del pane/tab es un efecto automático
  del código.
- **Paso 3 de las tres skills** (`skills/claude/SKILL.md`,
  `skills/codex/SKILL.md`, `skills/kimi/inharness.md`): nota + ejemplo para
  lanzar las filas delegadas con `node -e` cargando
  `paneLauncher.launchInPane(...)` (Bash con `run_in_background: true`, como
  el paralelismo ya existente), log en `.inharness/log/<id>-<cli>.log` y
  espera con `waitForCompletion` cuando una fila depende de otra.

### Cambiado
- `src/spawnCli.js` queda intacto: sigue usándose para los probes invisibles
  del descubrimiento (Paso 0) y como motor del modo fallback.

### Corregido
- **`input` colgaba para siempre en modo pane/tab.** El `input` (el prompt
  que recibe un CLI como Codex) se escribía en el stdin del propio `wt.exe`
  lanzado, pero `wt.exe` no reenvía su stdin al pane/tab que crea — son
  consolas distintas. El proceso real se quedaba esperando una entrada que
  nunca llegaba, sin escribir nunca la línea sentinel. Ahora el `input` se
  escribe antes en un fichero temporal y el helper que corre dentro del
  pane/tab lo lee de ahí y lo vuelca en el stdin real del proceso, borrando
  el fichero al terminar. Verificado end-to-end (pane real + `input` real
  llegando al proceso hijo), no solo por lectura de código.
- `spawn('wt.exe', ...)` ahora cae a `fallback` si lanza excepción al
  arrancar (antes no estaba cubierto).
- **`windowsHide: true` en el `spawn('wt.exe', ...)` dejaba el pane/tab
  oculto.** El proceso arrancaba y terminaba bien (log y sentinel correctos),
  pero nunca aparecía nada en pantalla — justo lo contrario de lo que pide
  esta función. Confirmado en vivo con el usuario: sin `windowsHide`, la
  pestaña/ventana de Windows Terminal se ve.
- **Nombres de comando sin `.cmd` fallaban dentro del pane.** Shims npm como
  `kimi` existen como script plano (resuelto por un shell POSIX) y como
  `kimi.cmd` (el que necesita `CreateProcess` sin shell). Si el llamador pasa
  el nombre plano, el proceso moría con ENOENT en milisegundos y la pestaña
  se cerraba sola antes de que nadie llegara a verla. Nuevo
  `resolveWindowsCmd(command)` prueba si existe `<command>.cmd` (igual que ya
  hace `discovery.js` para `spawnCli`) y lo usa si lo encuentra, tanto en
  pane/tab como en fallback.
- **Modo `tab` abría siempre una ventana nueva, nunca una pestaña.** Invocar
  `wt.exe new-tab` desde fuera de una sesión de Windows Terminal (que es
  justo el caso normal, ya que el orquestador no corre dentro de WT) crea
  siempre una ventana separada si no se le dice lo contrario — confirmado en
  vivo con el usuario: tres filas, tres ventanas, ninguna como pestaña.
  Añadido `-w 0` a los argumentos de `wt.exe` (reutiliza la última ventana
  activa si hay alguna; si no hay ninguna, crea la primera igual que antes).
  Reverificado en vivo: dos filas en paralelo (Kimi y Codex, modelos
  distintos) aparecen como dos pestañas dentro de la misma ventana.

## 0.2.2 — 2026-10-04

### Corregido
- **Detección de Claude y Kimi en Windows.** Los globales npm se instalan como
  shims `.cmd`; `spawnCli('claude', ...)` y `spawnCli('kimi', ...)` fallaban en
  silencio porque el wrapper `cmd.exe` solo se activaba para rutas que ya
  terminaban en `.cmd`. El nuevo helper `resolveCmd(name)` prueba el nombre
  plano primero (funciona en Linux/Mac y ejecutables nativos de Windows) y, si
  falla, reintenta con `name.cmd` antes de declarar el CLI como no instalado.
- **Traspaso de terminal para Claude y Kimi en Windows.** `handoff.js` ahora
  usa el `resolvedCmd` detectado en el descubrimiento y aplica el mismo wrapper
  `cmd.exe /d /s /c` que ya se usaba para Codex.
- **Detección de Codex en Linux/Mac.** `detectCodex` invocaba `codex.cmd`
  directamente, lo que fallaba fuera de Windows. Ahora pasa también por
  `resolveCmd`.

### Cambiado
- Eliminadas las advertencias de versión. La comprobación contra versiones
  hardcodeadas generaba falsos positivos en cualquier actualización de los CLIs
  y no aportaba información accionable. La herramienta funciona con cualquier
  versión instalada.

## 0.2.1 — 2026-09-29

### Cambiado
- Documentación revisada: el README presenta el problema que resuelve
  inharness y los problemas identificados durante el stress test previo a la
  publicación, con su solución.
- `package.json`: ruta del ejecutable normalizada (`bin/inharness.js`).

Sin cambios de comportamiento en las skills.

## 0.2.0 — 2026-09-28

Cambios en las tres variantes de la skill (`skills/claude/SKILL.md`,
`skills/codex/SKILL.md`, `skills/kimi/inharness.md`). `syncSkills` las
reinstala automáticamente en el siguiente arranque de `inharness` al detectar
la nueva versión.

### Añadido
- **Respaldo por cupo.** El mapeo del Paso 1 incluye un respaldo en otro CLI
  para cada nivel. Nuevo protocolo "Fila cortada por cupo" en el Paso 3:
  detectar el límite (usage limit, quota, rate limit, 403/429 de cupo o falta
  de respuesta), marcar la fila `bloqueada-cupo` con hora y mensaje, relanzarla
  en el respaldo continuando desde los ficheros parciales y, si el respaldo
  también está limitado, dejarla bloqueada. Al retomar, las filas
  `bloqueada-cupo` tienen prioridad.
- **Estado `bloqueada-cupo`** en `.inharness/assignment.md`, también tenido en
  cuenta al ofrecer continuar una sesión anterior.
- **Ficheros compartidos.** El Paso 2 prohíbe asignar a filas paralelas los
  ficheros que usan varias filas (configuración de tests, manifiestos y
  lockfiles, módulos comunes): los prepara el orquestador, y las filas piden
  los cambios en su resumen.
- **Aviso de red en Codex.** El sandbox `workspace-write` no tiene red: el
  orquestador instala las dependencias antes, deja para sí u otro CLI las
  pruebas con red y lo indica en el prompt. En la variante de Codex (Codex
  como orquestador), las filas que necesitan red se asignan a Claude o Kimi.

### Cambiado
- **"Comprobación mecánica" pasa a "comprobación proporcional".** Para filas
  que solo producen documentos o datos, sigue bastando con el código de
  salida y que el fichero exista y no esté vacío. Para filas que producen
  código, el orquestador ejecuta los tests o el comando que lo demuestre. El
  autoinforme del sub-agente nunca cuenta como prueba.
- **Regla de verificación.** La fila que audita a otra contrasta resultados
  reales (ejecuta tests, compara salidas) en lugar de leer el resumen.

### Contexto
Los cuatro cambios responden a problemas identificados durante el stress test
previo a la publicación, orquestando desarrollos con decenas de tareas en
paralelo entre los tres CLIs: un cupo de uso agotado a mitad de una tarea,
entregables dados por buenos con errores reales, una edición concurrente en un
fichero compartido que rompió varias tareas a la vez, y fallos silenciosos de
instalación de dependencias en el sandbox de Codex.

## 0.1.1 — 2026-09-26

Primera versión publicada: detección de CLIs por suscripción, elección de
orquestador, traspaso real del terminal e instalación de las skills nativas en
Claude Code, Codex y Kimi Code.
