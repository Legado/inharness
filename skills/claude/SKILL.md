---
name: inharness
description: Orquesta una tarea entre Claude (tú mismo), Codex y Kimi por suscripcion (sin API keys), repartiendo por complejidad/coste y ejecutando con tu aprobacion. Usar cuando el usuario pida trabajo "multiagente", "reparte esto entre modelos", invoque /inharness, o pida usar Codex/Kimi/Claude juntos para una tarea.
---

# inharness — orquestacion multi-CLI por suscripcion

## Tablero de control

Al lanzar cualquier fila o subagente, ejecuta `inharness report --id <id> --state running --kind row|subagent --parent <id-padre> --cli <cli>`; al terminar, informa `--state done`, `failed` o `quota`. Mantén `.inharness/now.md` al día con la fase actual. El usuario abre el tablero en otra pestaña con `inharness board --open`.

**Cada vez que esta skill se active** (por `/inharness`, o porque la tarea
encaja en su descripción), tu primera línea de respuesta —antes de
descubrimiento, antes de nada— es una confirmación explícita:
"inharness activo — orquestando entre Claude, Codex y Kimi." Es la única
señal fiable que tiene el usuario de que esto se disparó y no una respuesta
normal; no la des por descontada ni la omitas nunca, ni siquiera si ya la
diste antes en la misma conversación (cada activación se anuncia).

Tú (esta sesión de Claude Code) eres el orquestador cuando se invoca esta
skill. No canvasedes a un CLI externo para "decidir" — razonas tú mismo el
reparto, y solo shell-eas hacia Codex/Kimi para EJECUTAR las piezas que les
toquen. Nunca uses `--bare` en nada, nunca pases API keys: todo corre por
sesión de suscripción ya logueada.

**Codex y Kimi son binarios de línea de comandos YA instalados y YA
autenticados por suscripción en esta máquina** — se invocan como cualquier
otro comando de terminal para consultas (`codex.cmd --version`, `kimi provider list`)
y SOLO mediante `runRow.js` para ejecutar filas (Paso 3), nunca por red, nunca
con una clave de API, nunca eligiendo un "proveedor". Si en algún momento te
encuentras queriendo pedirle al usuario una API key, una clave, o "qué
proveedor/modelo de API usar", te has desviado por completo del propósito
de esta skill — para y vuelve a leer esto.

**Si un comando de Bash de esta skill pide aprobación al usuario**: antes
de lanzarlo, di en una frase qué vas a ejecutar y por qué (comprobar qué
modelos hay disponibles vía el CLI ya instalado — sin red, sin credenciales)
para que lo apruebe con confianza. **Si el usuario cancela esa aprobación o
el comando falla**: para ahí mismo y pregúntale explícitamente qué prefiere
hacer — nunca sigas adelante rellenando el hueco con una suposición (como
pedir una API key); es preferible preguntar que inventar un camino alterno.

## Memoria compartida (carpeta única, obligatoria)

Todo el estado vive en `.inharness/` dentro del directorio de trabajo
actual (créalo si no existe). Es la única fuente de verdad que cualquier
CLI orquestador (Claude, Codex o Kimi) puede leer para saber qué está
pasando — así el reparto sobrevive a que el usuario cierre la sesión o
cambie de CLI orquestador a mitad de proceso:

- `.inharness/discovery.md` — resultado del último Paso 0: CLIs disponibles,
  catálogo de modelos, qué modelos pasaron preflight con éxito, y fecha/hora.
  Es la caché que evita repetir descubrimiento en cada activación.
- `.inharness/task.md` — tarea original, análisis, mapeo de tiers aprobado.
- `.inharness/assignment.md` — tabla de estado por fila: id, rol, tier,
  cli/modelo resuelto, archivos, depende-de, estado (pendiente/en curso/
  hecho/fallido/bloqueada-cupo). Actualízala tú mismo después de cada fila, nunca al final.
- `.inharness/log/<id>-<cli>.log` — salida cruda de cada llamada, para
  auditoría si algo falla.

**Protocolo del panel (`inharness status`):** el orquestador DEBE escribir
`.inharness/now.md` al arrancar cada fase y cada vez que cambie. Son tres
líneas: `QUE HAGO: ...`, `ESPERANDO: ...`, `SIGUIENTE: ...`. DEBE mantener
`assignment.md` con una fila por tarea, id estable y estado normalizado:
`pendiente`, `en curso`, `hecho`, `fallido` o `bloqueada-cupo`. Actualiza la
fila en cuanto cambie el estado.

Antes de proponer nada, comprueba si `.inharness/assignment.md` ya existe
con filas pendientes o `bloqueada-cupo` de una sesión anterior — si es así, ofrece continuar
desde ahí en vez de re-planificar desde cero.

## Eficiencia (lean, obligatorio — no es opcional)

El propósito entero de esto es alargar el cupo de las suscripciones, no
gastarlo en idas y venidas. Cada salto a otro CLI cuesta cupo de ESA
suscripción y tokens de esta conversación — trátalos como recurso escaso:

- **Cachea el descubrimiento**: si `.inharness/discovery.md` existe y es de
  esta misma sesión de trabajo (mismo día, nadie ha tocado la carpeta desde
  entonces), NO repitas el Paso 0 completo — léelo y sigue. Solo refréscalo
  si: el usuario lo pide explícitamente, ha pasado a otra tarea claramente
  distinta, o un comando real falló por un motivo que el discovery debería
  haber cazado (modelo no habilitado, etc.).
- **Cachea el preflight**: si un modelo ya se probó con éxito en
  `.inharness/discovery.md` en esta carpeta, no lo vuelvas a probar antes
  de reusarlo.
- **Prompts a sub-agentes cortos y concretos**: dale a cada CLI la tarea y
  el alcance exactos, nada más — no le copies las reglas de esta skill ni
  el contexto de otras filas que no necesita.
- **Verifica con el método más barato que baste**: lee el diff o el archivo
  concreto, corre el test dirigido — no releas todo el árbol ni relances la
  suite completa si no hace falta.
- **Menos filas, mientras cada una siga siendo verificable por separado**:
  cada fila de más en otro CLI es un arranque+cierre de sesión completo, no
  es gratis.
- **No narres en prosa cada paso propio**: informa solo lo que el usuario
  necesita para aprobar o decidir, y los resultados/fallos — no repitas el
  contenido de esta skill de vuelta ni expliques de más lo que vas a hacer
  antes de hacerlo.
- **Paralelo sin esperas manuales**: si dos o más filas no dependen entre
  sí, lánzalas todas seguidas con `runRow.js launch` (cada una abre su
  pestaña y vuelve en segundos; ver Paso 3) y espéralas después con
  `runRow.js wait` en `Bash` con `run_in_background: true`. Tus propias
  filas con `Agent` también en paralelo. Solo esperas de verdad a una fila
  cuando otra depende de ella.
- **Comprobación proporcional, no narrada**: tras cada llamada, valida con
  lo mínimo que baste según lo que produce la fila. Si solo produce un
  documento o un archivo de datos, basta con el código de salida y que el
  archivo exista y no esté vacío. Si produce **código**, el código de salida
  no prueba nada: ejecuta tú los tests o el comando que demuestre que
  funciona y lee su resultado. **Nunca des por bueno el autoinforme del
  sub-agente** ("tests en verde", "hecho"): es una afirmación, no una
  prueba. Actualiza `.inharness/assignment.md`
  con una edición de una línea por fila (id · estado · resultado en pocas
  palabras) — no lo reescribas entero ni lo narres al usuario salvo que algo
  falle o necesite su decisión.

## Paso 0 — Descubrimiento en caliente

No asumas un catálogo de días o sesiones anteriores — los modelos cambian —
pero SÍ reusa el de esta misma sesión de trabajo si ya existe (ver
"Eficiencia" arriba). Si toca refrescarlo, ejecuta esto con Bash:

```bash
# Codex: auth + catalogo real de modelos
codex.cmd login status
cat "$HOME/.codex/models_cache.json"   # slug, display_name, priority,
                                        # default_reasoning_level,
                                        # supported_reasoning_levels

# Kimi: auth + catalogo real de modelos (el alias completo es "kimi-code/<id>")
kimi provider list
kimi provider list --json              # defaultEffort, supportEfforts, maxContextSize
```

Verificación de suscripción (nunca API):
- Codex: la salida de `login status` debe decir "Logged in using ChatGPT" (o similar). Si no, avisa y excluye Codex.
- Kimi: `provider list` debe mostrar `source=oauth`. Si no, avisa y excluye Kimi.
- Claude: eres tú mismo, ya autenticado por la sesión actual.

**Aviso de versión**: compara `codex.cmd --version` / `kimi --version` contra
las últimas que se verificaron con esta skill (Codex 0.157.1, Kimi 2.1.1). Si
difieren, dilo explícitamente al usuario antes de continuar — los flags de
abajo se verificaron contra esas versiones, no asumas que siguen siendo
correctos si hay una mayor.

**Preflight de modelos**: un modelo listado en el catálogo puede NO estar
habilitado en el plan real (visto con `kimi-for-coding-highspeed`: aparece
listado pero da 401 al invocarlo). No lo descubras al final del reparto —
si vas a comprometerte a un modelo que no hayas usado ya en esta sesión,
lánzale antes un prompt trivial de una línea para confirmar que responde,
antes de meterlo en el plan real.

## Paso 1 — Mapeo de modelos por complejidad (una vez, no por tarea)

Con el catálogo real delante, decide (o deja que el usuario ajuste) qué
modelo(s) atienden cada nivel. Puede haber más de un modelo por nivel
(para repartir carga entre proveedores):

```
alta  : <CLI>/<modelo> [@ esfuerzo]   (puede haber 2+)
media : <CLI>/<modelo> [@ esfuerzo]
baja  : <CLI>/<modelo> [@ esfuerzo]
```

Regla dura: NO pongas por defecto el modelo de mayor "priority" o el que
más se nombra ("el más nuevo") en "alta" solo por su nombre. Mira
`default_reasoning_level` / `defaultEffort` del catálogo real. Muestra este
mapeo en 3-4 líneas, nunca en párrafos.

Para cada nivel, anota también un **respaldo** en otro CLI (p. ej.
`media: kimi/kimi-for-coding · respaldo: codex/<modelo>`). Las suscripciones
tienen cupos (ventanas de 5 horas, límites semanales) y se agotan a mitad de
trabajo: el respaldo decidido de antemano evita improvisar cuando pase
(ver "Fila cortada por cupo" en el Paso 3).

## Paso 2 — Entender la tarea y proponer el reparto

Antes de proponer filas, evalúa en 2-3 frases qué tan acotada está la tarea
y por qué el número de piezas que vas a proponer es el que hace falta (ni
una plantilla fija de roles, ni inflar piezas para una tarea trivial: una
tarea de una línea puede necesitar 1 sola fila).

**Busca primero paralelismo real antes de conformarte con una sola fila.**
No te preguntes solo "¿cuántas piezas hacen falta?" sino "¿qué ángulos de
esta tarea son genuinamente independientes entre sí?" (p. ej., en una
auditoría: seguridad, portabilidad y consistencia de documentación son
revisiones distintas que pueden correr a la vez, cada una a un CLI/modelo
distinto). Esto incluye al propio CLI director — tú mismo —: si uno de esos
ángulos te lo puedes quedar tú, hazlo como una fila más (usa la herramienta
`Agent`, no te limites a repartir solo entre Codex y Kimi mientras tú solo
coordinas). Esto NO anula la regla de arriba: una tarea que de verdad no
tiene ángulos independientes sigue resolviéndose en 1 sola fila — lo que
cambia es que tienes que comprobarlo activamente cada vez, no asumirlo por
pereza ni resolverlo todo en el primer CLI que te venga a la cabeza.

Cada fila declara: qué hace (frase corta), a qué tier pertenece, qué
archivos toca (sin solape con otra fila — si se solapan, usa dependencia en
vez de paralelo), y de qué filas depende.

**Ficheros compartidos: solo los toca el orquestador.** El "sin solape" no
basta con los ficheros que usan varias filas a la vez aunque ninguna los
"posea": configuración de tests (`conftest.py`, `pytest.ini`, `jest.config.*`),
manifiestos y dependencias (`pyproject.toml`, `package.json`, lockfiles) y
módulos comunes que importan varias filas. No los asignes a filas que corren
en paralelo: prepáralos tú antes de lanzarlas, o después con lo que pidan.
Indica en el prompt de cada fila que no los modifique y que, si necesita un
cambio, lo diga en su resumen. Una edición concurrente en uno de estos
ficheros (un BOM, una dependencia, una fixture) rompe a la vez el trabajo de
todas las filas.

**Regla dura de verificación**: si una fila audita/testea el trabajo de
otra, debe resolverse a un CLI DISTINTO al de la fila que produjo ese
trabajo. Decídelo tú explícitamente al resolver el tier (no dejes que dé la
casualidad). La fila de verificación contrasta resultados reales (ejecuta
los tests, compara la salida con lo pedido) y no se limita a leer el
resumen de la fila verificada.

Preséntaselo al usuario con `AskUserQuestion` (tabla/preview en el prompt) —
opciones tipo "Aprobar tal cual", "Cambiar el mapeo de modelos", "Cambiar
roles/dependencias". Solo tras su aprobación pasas al Paso 3.

## Paso 3 — Ejecutar (solo lo aprobado)

**Filas de Claude dentro de Claude:** usa `Agent` con el modelo asignado
(`haiku`/`sonnet`/`opus`), sin lanzar un Claude externo. `Agent` no abre
pestaña; si el usuario quiere ver también esas filas, lánzalas con
`runRow.js launch --cli claude`.

**Codex:** el sandbox `workspace-write` no tiene red. No asignes a esa fila
instalar dependencias ni probar servicios en vivo; prepara tú las
dependencias y deja esas pruebas a otra fila. Indícalo en el prompt.
`--effort` admite low|medium|high|xhigh|max|ultra; usa un valor admitido por
el modelo del catálogo. `--sandbox` admite workspace-write (por defecto)
o read-only; no se aplica a Kimi ni a Claude.

**Kimi:** el prefijo `kimi-code/` se añade automáticamente. Nunca `--auto`
ni `-y` en modo `-p`. Usa el esfuerzo predeterminado del modelo.

**REGLA DURA - lanzar filas externas SOLO con runRow.js.** Toda fila que
ejecute otro CLI se lanza con `node "$HOME/.inharness/runtime/runRow.js" launch`
(recetas abajo; `inharness` lo instala en cada arranque). PROHIBIDO
ejecutar la fila con `codex exec`, `codex.cmd exec`, `kimi -p` o
`claude -p` directos, en segundo plano con `&` o `run_in_background`, o
redirigiendo a mano a `.inharness/log/`: asi la fila corre invisible y el
usuario no ve nada. Eso vale aunque la tarea se retome de otra sesion y el
log o `assignment.md` muestren llamadas crudas anteriores.

**Visibilidad en vivo (Windows Terminal):** `launch` abre una pestana
visible por fila: pane en la ventana actual si esta sesion corre dentro de
Windows Terminal (WT_SESSION), o pestana en una ventana propia llamada
"inharness" si no. Espera a que la pestana arranque y vuelve en segundos:
NO lo envuelvas en segundo plano. Lanza seguidas todas las filas
independientes y luego espera con `wait` (eso si, en segundo plano si tu
herramienta lo permite). Lee el JSON de `launch`: si `visible` es false o
trae `warning`, dile al usuario en ese momento el texto del aviso (fila
sin ventana, motivo) y no sigas como si tuviera pestana.

**Guardarrail tecnico:** bloquea llamadas crudas a Codex/Kimi mientras
haya filas activas en `.inharness/assignment.md` (de la carpeta actual, de
una padre, o del destino de `cd`/`-C`). En texto libre, toda linea que
empiece por id (F2, P1...) sin "hecho"/"fallido" cuenta como activa. Salida de emergencia: `INHARNESS_ALLOW_RAW=1`.
La delegacion caduca a las 12 h; la variable no caduca: retirala al terminar.
Bash: `INHARNESS_ALLOW_RAW=1 comando`; PowerShell: establece
`$env:INHARNESS_ALLOW_RAW="1"` y retirala despues con
`Remove-Item Env:INHARNESS_ALLOW_RAW`. Kimi no tiene hooks.
El hook de Claude se instala en `~/.claude/settings.json`.

Escribe el prompt autocontenido con el editor en
`.inharness/prompts/<id>.md`. Los ejemplos siguientes usan la fila 3:
crea primero `.inharness/prompts/3.md` y adapta id, CLI, modelo y esfuerzo
al reparto aprobado. Son el mismo texto en bash, Git Bash y PowerShell.
`--cwd` fija la raíz explícita; el prompt debe estar dentro de ella,
también tras resolver enlaces: fichero regular UTF-8, sin controles
binarios, de hasta 1 MiB. Los logs y su estado no admiten enlaces.

```bash
# codex
node "$HOME/.inharness/runtime/runRow.js" launch --id 3 --cli codex --model gpt-6-sol --effort high --prompt-file .inharness/prompts/3.md

# kimi
node "$HOME/.inharness/runtime/runRow.js" launch --id 3 --cli kimi --model kimi-for-coding --prompt-file .inharness/prompts/3.md
```

Codex y Claude reciben el prompt por stdin. Kimi lo recibe como argumento
hasta 20000 caracteres, siempre que la línea completa escapada quepa en
CreateProcess (32767 unidades UTF-16 con el NUL final). Si no cabe, recibe
una instrucción con la ruta relativa citada en JSON para leer el fichero.
No se ha vuelto a verificar aquí el soporte de stdin de Kimi.
Codex añade `--output-last-message .inharness/log/<id>-codex-last.txt`.

`launch` imprime una línea JSON con id, cli, mode, pid, log, visible y window
(warning si no hay ventana; si la pestana no arranca, codigo 1); mode es pane,
tab o fallback. El log está en `.inharness/log/<id>-<cli>.log`.
Cuando otra fila dependa de esta, usa `wait`: devuelve 0 si ok, 1 si falló,
y JSON con exitCode, aborted, timedOut, error y outputTail (4000 caracteres).
`status` no bloquea: running | done | aborted | unknown. Errores de uso,
incluido un id ya ocupado (EBUSY), devuelven 2.
Limitación pendiente del launcher: en fallback no hay reserva de id;
no lances dos filas con el mismo id/CLI a la vez, pues pueden pisar el log.

```bash
node "$HOME/.inharness/runtime/runRow.js" wait --id 3 --cli codex --timeout-ms 600000
node "$HOME/.inharness/runtime/runRow.js" status --id 3 --cli codex
node "$HOME/.inharness/runtime/runRow.js" wait --id 3 --cli kimi --timeout-ms 600000
node "$HOME/.inharness/runtime/runRow.js" status --id 3 --cli kimi
```

Verifica cada fila antes de darla por buena: lee los archivos y ejecuta
los tests si produce código. Actualiza su estado en
`.inharness/assignment.md` inmediatamente después de cada fila.

**Fila cortada por cupo.** Si un CLI responde con un límite de uso ("usage
limit", "quota", "rate limit", un 403/429 que hable de cupo o de la ventana
de 5 horas) o se queda sin responder dentro de su tiempo máximo:
1. Marca la fila `bloqueada-cupo` en `.inharness/assignment.md`, con la hora
   y el mensaje recibido.
2. Relánzala en el **respaldo** de su nivel (Paso 1). Dale en el prompt lo
   que la fila anterior ya dejó hecho (ficheros parciales) para que continúe
   y no empiece de cero. Avisa al usuario en una línea.
3. Si el respaldo también está limitado, deja la fila en `bloqueada-cupo` y
   dilo. Al retomar el trabajo más tarde, las filas `bloqueada-cupo` se
   reintentan antes que las pendientes.

## Paso 4 — QA final y cierre

Tú (el orquestador) revisas el conjunto contra lo que pidió el usuario,
reportas qué hizo cada fila (rol — CLI/modelo — resultado) en una lista
corta, y señalas cualquier fallo o modelo que tuvo que excluirse (401,
versión no verificada, etc.) en vez de omitirlo silenciosamente. Deja
`.inharness/assignment.md` reflejando el estado final real.
