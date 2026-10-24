# inharness

**Reparte una tarea entre Claude, Codex y Kimi usando las suscripciones que ya pagas. Sin API keys. Sin facturar por token. Sin salir del CLI donde ya trabajas.**

> Versión 0.5.0. Antes de publicarla se sometió a un stress test: orquestación
> de desarrollos reales con decenas de tareas en paralelo entre los tres CLIs.
> Lo que falló durante esas pruebas está documentado más abajo, junto con cómo
> se resolvió. Si encuentras un borde que no está cubierto, abre un issue.

## El problema

Cada vez más desarrolladores y equipos trabajan con varios asistentes de
código por suscripción a la vez: Claude Code, Codex CLI, Kimi Code. Cada uno
tiene modelos rápidos y baratos y modelos de frontera, y cada uno tiene su
propio cupo. En la práctica se usan de uno en uno, porque coordinarlos a mano
supone abrir varias terminales, copiar contexto de una a otra y recordar cuál
es el modelo adecuado de cada herramienta para cada tipo de tarea.

Las soluciones de orquestación multiagente que existen suelen partir de APIs:
exigen claves, facturan por token y dejan fuera las suscripciones que ya se
pagan.

inharness resuelve ese hueco de la forma más sencilla posible: coordina los
tres CLIs usando las sesiones de suscripción que ya tienes abiertas, repartiendo
cada pieza de trabajo según su complejidad y su coste.

## El enfoque

Un planteamiento habitual es un orquestador externo que hace de "cerebro":
pregunta, planifica y lanza llamadas a los demás por su cuenta. Funciona, pero
añade una herramienta más con su propio criterio, ajena a la que ya usas.

inharness hace lo contrario: **no razona nada por su cuenta.** Solo hace tres
cosas:

1. Detecta qué CLIs tienes instalados con sesión de suscripción activa.
2. Te deja elegir con cuál quieres trabajar (el orquestador).
3. Te entrega el control real de esa sesión, la interactiva de siempre.

El reparto lo decide el propio CLI que elegiste, mediante una skill nativa
instalada dentro de él. Decide con la misma calidad que aplica a su propio
trabajo, y llama a los otros dos por línea de comandos solo para ejecutar las
piezas que les tocan.

## Problemas identificados durante el stress test

Todos aparecieron usando la herramienta en condiciones reales, no sobre el
papel. Por eso están documentados en lugar de pulidos hasta desaparecer.

**Integración entre CLIs**

- **Kimi se bloqueaba en la segunda pregunta** cuando la entrada llegaba por
  pipe. Era un problema conocido de Node con `readline` y streams no
  interactivos. Se resolvió consumiendo el iterador de líneas directamente.
- **Los prompts largos rompían Codex en silencio.** En Windows, `codex.cmd`
  pasa por `cmd.exe`, que limita la línea de comandos a ~8191 caracteres. Se
  resolvió pasando el prompt por stdin.
- **PowerShell bloqueaba el comando** por su política de ejecución: el shim
  `.ps1` que genera `npm link` no arranca con la política por defecto de
  muchos equipos Windows. Afecta a cualquier CLI de Node instalado
  globalmente.
- **Codex fallaba con "the CLI package does not match this platform"** al
  recibir el control del terminal. Hacía falta `--no-daemon` para que no
  intentara conectar con su servidor en segundo plano.
- **Un modelo listado no siempre está habilitado en el plan.**
  `kimi-for-coding-highspeed` aparece en `kimi provider list` pero devuelve
  401 al usarlo. De ahí el preflight antes de comprometerse con un modelo.
- **El orquestador podía rellenar huecos con suposiciones.** Ante un comando
  cancelado, llegó a pedir una API key, justo lo contrario del propósito del
  proyecto. Cada skill incluye ahora una regla explícita: si algo falla, se
  para y se pregunta.

**Orquestación a escala (0.2.0)**

- **Los cupos se agotan a mitad de trabajo.** Un CLI alcanzó su ventana de
  uso de 5 horas en mitad de una tarea. Cada nivel del mapeo lleva ahora un
  respaldo en otro CLI. Una tarea cortada se marca `bloqueada-cupo`, se
  relanza en el respaldo continuando desde lo que ya estaba escrito y, al
  retomar, se reintenta antes que las pendientes.
- **"Código de salida 0" no significa "funciona".** Entregables marcados como
  "tests en verde" por el propio sub-agente contenían errores reales. En las
  tareas que producen código, el orquestador ejecuta los tests él mismo y
  nunca acepta el autoinforme de un sub-agente como prueba.
- **Los ficheros compartidos rompen el trabajo en paralelo.** Repartir los
  ficheros entre tareas no basta: la configuración de tests, los manifiestos y
  los módulos comunes los usan todas. Una edición concurrente (un BOM en
  `conftest.py`) rompió varias tareas a la vez. Ahora esos ficheros solo los
  toca el orquestador.
- **El sandbox de Codex no tiene red.** Con `--sandbox workspace-write`, Codex
  no puede instalar dependencias ni probar nada en vivo, y a veces lo da por
  hecho. El orquestador instala las dependencias antes, y las pruebas con red
  las hace él o las asigna a otro CLI.

**Detección y traspaso multiplataforma (0.2.2)**

- **Claude y Kimi no se detectaban en Windows.** Los globales npm se instalan
  como shims `.cmd`; `spawnCli('claude', ...)` fallaba en silencio porque el
  wrapper `cmd.exe` solo se activaba para rutas que ya terminaban en `.cmd`.
  Un nuevo helper prueba el nombre plano primero y, si falla, reintenta con
  `.cmd` antes de declarar el CLI como no instalado.
- **El traspaso de terminal fallaba en Windows para Claude y Kimi.** `handoff.js`
  ahora usa el `resolvedCmd` detectado en el descubrimiento y aplica el mismo
  wrapper `cmd.exe /d /s /c` que ya se usaba para Codex.
- **Codex no se detectaba en Linux/Mac.** `detectCodex` invocaba `codex.cmd`
  directamente, lo que fallaba fuera de Windows. Ahora pasa también por el
  mismo helper de resolución multiplataforma.

El detalle de cada versión está en [CHANGELOG.md](CHANGELOG.md).

## Cómo se ve

```
$ npx inharness
Deteccion de CLIs (suscripcion, no API):
  ✔ claude   2.1.268  — sin ANTHROPIC_API_KEY
  ✔ codex    0.157.1  — Logged in using ChatGPT
  ✔ kimi     2.1.1    — source=oauth

¿Con que CLI quieres trabajar (orquestador)?
  1) claude   2) codex   3) kimi
> 2

Entrando en codex. Trabaja normal.
```

Y dentro de esa sesión, cuando haga falta:

```
> $inharness haz una landing sencilla para un producto

inharness activo - orquestando entre Codex, Claude y Kimi.

alta  : codex/gpt-6-astra @ high    · respaldo: claude/opus
media : kimi/kimi-for-coding        · respaldo: codex/gpt-6-luna
baja  : claude/haiku                · respaldo: kimi/kimi-for-coding

#1 [media] estructura HTML/CSS de la landing        → kimi/kimi-for-coding
#2 [baja]  copy y textos                            → claude/haiku
#3 [alta]  revisión de accesibilidad y responsive    → codex/gpt-6-astra (tú)

¿Apruebas este reparto?
```

## Instalación

```bash
npx inharness
```

o instalado de forma permanente:

```bash
npm install -g inharness
inharness
```

> **¿npm va por detrás?** Si el paquete publicado en npm no es la versión más
> reciente, instala directamente desde GitHub:
>
> ```bash
> npm install -g github:Legado/inharness
> ```

La primera vez que se ejecuta, instala (o actualiza) las skills nativas en las
tres herramientas:

| CLI | Dónde queda instalado | Cómo se activa dentro de esa sesión |
|---|---|---|
| Claude Code | `~/.claude/skills/inharness/` | `/inharness <tarea>` |
| Codex | `~/.codex/skills/inharness/` | `$inharness <tarea>`, o pidiéndolo con tus palabras |
| Kimi Code | `~/.kimi-code/agents/inharness.md` | ya viene cargado si entras por `inharness` |

Necesitas tener instalado, con sesión de suscripción (no por API key), al
menos uno de los tres: [Claude Code](https://claude.com/product/claude-code),
[Codex CLI](https://github.com/openai/codex),
[Kimi Code](https://github.com/MoonshotAI/kimi-code).

## Qué hace la skill una vez activada

1. **Descubre en caliente** el catálogo real de las otras dos CLIs. Nunca usa
   una lista de modelos escrita a mano, porque los modelos cambian.
2. **Mapea modelos por complejidad** (alta, media, baja), no por nombre. Un
   modelo "nuevo" no es automáticamente el adecuado para documentar.
3. **Entiende la tarea antes de repartir.** Una tarea trivial no genera cuatro
   roles de plantilla; una tarea ambigua genera primero una fila para acotarla.
4. **Nunca deja que un modelo se revise a sí mismo.** Si una tarea verifica el
   trabajo de otra, va a un CLI distinto del que lo produjo, y contrasta
   resultados reales en lugar de leer un resumen.
5. **Guarda el estado en `.inharness/`**, dentro de tu carpeta de trabajo,
   para que el reparto sobreviva a que cierres la sesión o cambies de CLI
   orquestador a mitad de camino.
6. **Pide aprobación antes de ejecutar nada**, y el mapeo de modelos se puede
   cambiar en cualquier momento.
7. **Sobrevive a los límites de cupo:** cada nivel tiene un respaldo en otro
   CLI.
8. **No se fía del "hecho" de un sub-agente:** en tareas de código ejecuta los
   tests antes de darlas por buenas.
9. **Protege los ficheros compartidos:** configuración de tests, manifiestos y
   módulos comunes solo los toca el orquestador.

## Lo que no hace (todavía, o nunca)

- No tiene lógica de IA propia: el razonamiento del reparto lo hace el CLI que
  elegiste, con sus capacidades y sus límites.
- No garantiza que un modelo listado esté habilitado en tu plan. Hace un
  preflight barato antes de comprometerse, pero no es infalible.
- No sustituye tu criterio: siempre puedes rechazar o editar el reparto.
- No está probado a fondo en macOS ni Linux. Se desarrolló y se probó en
  Windows; el código está escrito para ser portable, pero "escrito para" no es
  lo mismo que "verificado en".

## Cómo está hecho

```
bin/inharness.js       lanzador: descubrimiento + elección + traspaso de terminal
src/discovery.js       detección en caliente de CLIs, modelos y suscripción
src/handoff.js         traspasa el control real del terminal al CLI elegido
src/syncSkills.js      instala/actualiza las skills nativas en cada CLI
src/resolveExe.js      resuelve ejecutables a ruta absoluta (PATH/PATHEXT, nunca el cwd)
src/winArgs.js         argumentos seguros en Windows: shims npm directos, cmd.exe con escape y fallo cerrado
src/spawnCli.js        invocación robusta entre plataformas (sobre resolveExe + winArgs)
src/paneLauncher.js    lanza las filas delegadas con visibilidad en vivo (pane/tab/fallback)
src/runRow.js          CLI estable `launch|wait|status` que usan las skills (sin comillas de shell)
src/installRuntime.js  copia el runtime a ~/.inharness/runtime (ruta estable de hooks y skills)
src/guardLogic.js      detecta invocación cruda + delegación activa (compartido)
src/claudeGuardHook.js guardarraíl PreToolUse para Claude Code
src/codexPreToolUse.cjs guardarraíl PreToolUse para Codex
src/installGuardrails.js instala/actualiza los dos guardarraíles de forma idempotente
src/catalogCache.js    persiste el catálogo de CLIs/modelos en ~/.inharness/catalog.json
skills/claude/         SKILL.md para Claude Code
skills/codex/          SKILL.md + agents/openai.yaml para Codex
skills/kimi/           agente markdown para Kimi Code
```

`inharness` no simula el traspaso de terminal: lo hace de verdad
(`stdio: inherit`). Cada skill invoca a los otros dos CLIs por línea de
comandos, con la sintaxis verificada contra sus versiones actuales, y avisa si
detecta una versión distinta de la probada.

**Visibilidad en vivo (pane → tab → fallback).** Las filas delegadas no corren
invisibles: `src/paneLauncher.js` las abre en un split-pane de Windows Terminal
si la sesión ya vive en él (`WT_SESSION`), en una pestaña nueva si hay `wt.exe`,
y cae a ejecución síncrona sin ventana si no (`INHARNESS_FORCE_FALLBACK=1` lo
fuerza). El orquestador no construye comandos: usa
`node ~/.inharness/runtime/runRow.js launch --id … --cli codex|kimi|claude --model … --prompt-file …`
(y `wait`/`status` con `--id` y `--cli`); el log queda en `.inharness/log/<id>-<cli>.log`.
`INHARNESS_PANE_LINGER_MS` ajusta cuánto sigue abierta la pestaña al terminar (2 s si va bien, 15 s si falla).
Nada sensible viaja por la línea de comandos de `wt.exe`: los parámetros van en un
fichero temporal de un solo uso (0600, nombre aleatorio) y el prompt por stdin del
hijo. El resultado se comunica fuera de banda: `<log>.exit` (JSON atómico con
código, señal, error, `aborted`, tiempos) y `<log>.pid`; no hay centinela en el log.
`launch` sobre un log con ejecución viva falla con `EBUSY`.

**Windows seguro.** Los shims `.cmd` de npm (`codex`, `kimi`, …) se resuelven y
se lanzan como `node script.js` directamente, sin pasar por cmd.exe: no hay
inyección, saltos de línea ni límite de 8191. Los shims de binario nativo
(`claude.cmd` → `claude.exe`) lanzan el `.exe` directo. Un `.cmd`/`.bat` que no es shim se
ejecuta con escape y se rechaza (`EUNSAFEARG`) si contiene `%`, LF, CR o NUL.

**Linux/macOS.** Solo modo fallback (sin panes visibles); la lógica es la misma pero
solo se ha verificado en Windows. Windows Terminal es la única vista en vivo.

**Guardarraíl técnico, no solo una regla de prompt.** Que una skill "deba"
pasar por `paneLauncher` en vez de invocar Codex/Kimi crudo es una
instrucción de prompt — y un orquestador puede no seguirla (nos pasó
construyendo esto). Por eso `inharness` instala, en cada arranque y de
forma idempotente, un hook `PreToolUse` real:
- **Claude Code** (`~/.claude/settings.json`): bloquea la llamada Bash antes
  de ejecutarla si coincide con una invocación cruda y hay una fila activa
  en `.inharness/assignment.md`. Verificado en vivo: bloquea sin reinicio.
- **Codex** (`~/.codex/hooks.json`): mismo mecanismo, matcher `^Bash$`
  (verificado empíricamente contra el app-server real). Un hook nuevo queda
  *untrusted* hasta que lo confirmas una vez en `/hooks` dentro de una
  sesión de Codex — es una puerta de seguridad deliberada de Codex, no algo
  que `inharness` pueda o deba saltarse.
- **Kimi Code**: no tiene mecanismo de hooks hoy. No hay guardarraíl técnico
  posible ahí todavía — solo la regla de prompt en su skill.

Los hooks apuntan a `~/.inharness/runtime/` (copia estable, no al paquete npx),
caducan a las 12 h de `assignment.md` (`INHARNESS_STALE_HOURS`) y fallan abiertos.
Salidas: `INHARNESS_ALLOW_RAW=1` en el comando permite una invocación cruda puntual;
`INHARNESS_NO_GUARDRAILS=1` desactiva la instalación de hooks y runtime.
`inharness` copia `settings.json`/`hooks.json` a `<fichero>.bak-inharness` antes de tocarlos.

**Catálogo persistente.** Cada arranque de `inharness` también escribe el
descubrimiento de CLIs/modelos en `~/.inharness/catalog.json` (global, no
por proyecto), como punto de arranque rápido para las skills.

## Panel de control (inharness status)

`inharness status` muestra el avance de las filas de `.inharness/assignment.md`,
el estado observado en `.inharness/log/` y la nota del orquestador en
`.inharness/now.md`. No inicia sesiones ni modifica esos archivos. `inharness`
sin argumentos conserva el lanzador interactivo.

```text
inharness status  proyecto  2026-01-01T12:00:00.000Z
[█████░░░░░] 1/2  running:1 failed:0 dead:0 quota:0 pending:0 done:1

┌──────────────────────────────────────────────────────────┐
│ AHORA MISMO  (hace 8s)                                   │
│ QUE HAGO: revisar resultados                              │
│ ESPERANDO: A1                                             │
│ SIGUIENTE: ejecutar pruebas                               │
└──────────────────────────────────────────────────────────┘

ID          ESTADO            CLI/MODELO        TIEMPO    ULTIMA SALIDA
A1          ● running         codex/modelo      1m 2s     pruebas en curso
B2          ✔ done            kimi/modelo       40s       terminado
```

Usa `inharness status --watch` (o `inharness watch`) para refrescar cada cinco
segundos; `--interval <s>` cambia el intervalo y `q` o Ctrl+C salen. `--cwd
<dir>` elige el proyecto, `--json` entrega una instantánea para scripts,
`--ascii` usa caracteres ASCII y `--no-color` desactiva el color. Si stdout no
es un terminal, `--watch` imprime una sola vez y avisa por stderr. La salida
del log se limita a dos líneas, se limpia de controles y se redactan secretos
comunes antes de mostrarla.

## Tests

`npm test` (`node --test`, sin dependencias). `INHARNESS_LIVE_WT=1` activa las
pruebas con Windows Terminal real.

## Contribuir

Si algo no encaja con tu versión de Claude Code, Codex o Kimi Code, abre un
issue con la salida de `<cli> --version`. Las skills están verificadas contra
versiones concretas y avisan si detectan una distinta; mantenerlas al día es la
contribución más útil.

## Licencia

MIT. Ver [LICENSE](LICENSE).
