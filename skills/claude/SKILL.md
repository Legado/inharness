---
name: inharness
description: Orquesta una tarea entre Claude (tú mismo), Codex y Kimi por suscripcion (sin API keys), repartiendo por complejidad/coste y ejecutando con tu aprobacion. Usar cuando el usuario pida trabajo "multiagente", "reparte esto entre modelos", invoque /inharness, o pida usar Codex/Kimi/Claude juntos para una tarea.
---

# inharness — orquestacion multi-CLI por suscripcion

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
otro comando de terminal (`codex.cmd ...`, `kimi ...`), nunca por red, nunca
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
  hecho/fallido). Actualízala tú mismo después de cada fila, nunca al final.
- `.inharness/log/<id>-<cli>.log` — salida cruda de cada llamada, para
  auditoría si algo falla.

Antes de proponer nada, comprueba si `.inharness/assignment.md` ya existe
con filas pendientes de una sesión anterior — si es así, ofrece continuar
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
- **Usa tu propio mecanismo nativo de paralelismo, no una espera manual**:
  si dos o más filas no dependen entre sí, lánzalas con `Bash`
  `run_in_background: true` (el mismo mecanismo que ya usa esta sesión para
  sus propios subagentes) en vez de esperar una a una en secuencia. Solo
  esperas de verdad a una fila cuando otra depende de ella.
- **Comprobación mecánica, no narrada**: tras cada llamada, valida con lo
  mínimo que baste — código de salida y, si tocaba escribir un archivo, que
  exista y no esté vacío. Eso es la comprobación por defecto; solo profundiza
  (leer contenido, correr un test) si la fila es de las que de verdad lo
  requieren (p.ej. la fila de tests). Actualiza `.inharness/assignment.md`
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

## Paso 2 — Entender la tarea y proponer el reparto

Antes de proponer filas, evalúa en 2-3 frases qué tan acotada está la tarea
y por qué el número de piezas que vas a proponer es el que hace falta (ni
una plantilla fija de roles, ni inflar piezas para una tarea trivial: una
tarea de una línea puede necesitar 1 sola fila).

Cada fila declara: qué hace (frase corta), a qué tier pertenece, qué
archivos toca (sin solape con otra fila — si se solapan, usa dependencia en
vez de paralelo), y de qué filas depende.

**Regla dura de verificación**: si una fila audita/testea el trabajo de
otra, debe resolverse a un CLI DISTINTO al de la fila que produjo ese
trabajo. Decídelo tú explícitamente al resolver el tier (no dejes que dé la
casualidad).

Preséntaselo al usuario con `AskUserQuestion` (tabla/preview en el prompt) —
opciones tipo "Aprobar tal cual", "Cambiar el mapeo de modelos", "Cambiar
roles/dependencias". Solo tras su aprobación pasas al Paso 3.

## Paso 3 — Ejecutar (solo lo aprobado)

Para cada fila, en orden de dependencias:

- **Fila resuelta a Claude**: usa la herramienta `Agent` (subagente en
  proceso) con el modelo que le toque (`haiku`/`sonnet`/`opus`), NO invoques
  un `claude -p` externo desde Bash — es más lento y no aporta nada al
  correr ya dentro de Claude Code.
- **Fila resuelta a Codex**:
  ```bash
  codex.cmd exec -m <modelo> \
    -c model_reasoning_effort=<esfuerzo> \
    --sandbox workspace-write --skip-git-repo-check \
    -C "<directorio de trabajo>" \
    - \
    --output-last-message "<archivo temporal>" <<'EOF'
  <prompt completo y autocontenido para esa fila>
  EOF
  ```
  El `-` + heredoc/stdin es obligatorio si el prompt es largo: pasarlo como
  argumento revienta el límite de ~8191 caracteres de línea de comandos de
  `cmd.exe` (que envuelve a `codex.cmd` en Windows) y falla en silencio.
- **Fila resuelta a Kimi**:
  ```bash
  kimi -m kimi-code/<modelo> -p "<prompt>"
  ```
  Alias completo obligatorio. NUNCA añadas `--auto` (el clasificador de
  auto-mode de Claude Code lo bloquea con "Create Unsafe Agents") ni `-y`
  (incompatible con `-p`). El modo por defecto de `-p` ya ejecuta escrituras
  de archivo rutinarias sin bloquear. Kimi no tiene forma de fijar el nivel
  de esfuerzo por invocación (limitación conocida) — usa el que traiga el
  modelo por defecto y dilo si es relevante.

Verifica cada fila (leer el archivo resultante, correr tests si aplica)
antes de dar por buena la siguiente si depende de ella. Actualiza el estado
de esa fila en `.inharness/assignment.md` inmediatamente (no esperes al
final) — es lo que permite retomar el trabajo si el usuario corta la sesión
a mitad de proceso.

## Paso 4 — QA final y cierre

Tú (el orquestador) revisas el conjunto contra lo que pidió el usuario,
reportas qué hizo cada fila (rol — CLI/modelo — resultado) en una lista
corta, y señalas cualquier fallo o modelo que tuvo que excluirse (401,
versión no verificada, etc.) en vez de omitirlo silenciosamente. Deja
`.inharness/assignment.md` reflejando el estado final real.
