# inharness

**Reparte una tarea entre Claude, Codex y Kimi usando las suscripciones que ya pagas. Sin API keys. Sin facturar por token. Sin salir del CLI donde ya trabajas.**

> Versión 0.2.2. Antes de publicarla se sometió a un stress test: orquestación
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
src/spawnCli.js        invocación robusta entre plataformas (incl. .cmd de Windows)
skills/claude/         SKILL.md para Claude Code
skills/codex/          SKILL.md + agents/openai.yaml para Codex
skills/kimi/           agente markdown para Kimi Code
```

`inharness` no simula el traspaso de terminal: lo hace de verdad
(`stdio: inherit`). Cada skill invoca a los otros dos CLIs por línea de
comandos, con la sintaxis verificada contra sus versiones actuales, y avisa si
detecta una versión distinta de la probada.

## Contribuir

Si algo no encaja con tu versión de Claude Code, Codex o Kimi Code, abre un
issue con la salida de `<cli> --version`. Las skills están verificadas contra
versiones concretas y avisan si detectan una distinta; mantenerlas al día es la
contribución más útil.

## Licencia

MIT. Ver [LICENSE](LICENSE).
