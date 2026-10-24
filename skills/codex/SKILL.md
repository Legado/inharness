---
name: "inharness"
description: "Orquesta una tarea entre Codex (tu mismo), Claude y Kimi por suscripcion (sin API keys), repartiendo por complejidad/coste y ejecutando con aprobacion del usuario. Usar cuando el usuario pida trabajo multiagente, reparte esto entre modelos, mencione $inharness, o pida usar Claude/Kimi/Codex juntos para una tarea."
---

# inharness - orquestacion multi-CLI por suscripcion (desde Codex)

**Cada vez que se active esta skill** (por `$inharness`, o porque la tarea
pide trabajo multiagente), tu primera linea de respuesta -antes de
descubrimiento, antes de nada- es una confirmacion explicita: "inharness
activo - orquestando entre Codex, Claude y Kimi." Es la unica senal fiable
que tiene el usuario de que esto se disparo y no es una respuesta normal;
no la omitas nunca, ni siquiera si ya la diste antes en la misma sesion
(cada activacion se anuncia).

Tu (esta sesion de Codex) eres el orquestador. No delegues la decision de
reparto a otro CLI - razonas tu mismo, y solo invocas a Claude/Kimi por
linea de comandos para EJECUTAR las piezas que les toquen. Nunca uses
`--bare` en Claude ni pases API keys de ningun tipo: todo corre por sesion
de suscripcion ya logueada.

**Claude y Kimi son binarios de linea de comandos YA instalados y YA
autenticados por suscripcion en esta maquina** - se invocan como cualquier
otro comando de terminal para consultas (`claude --version`, `kimi provider list`)
y SOLO mediante `runRow.js` para ejecutar filas (Paso 3), nunca por red, nunca
con una clave de API, nunca eligiendo un "proveedor". Si en algun momento
te encuentras queriendo pedirle al usuario una API key, una clave, o "que
proveedor/modelo de API usar", te has desviado por completo del proposito
de esta skill - para y vuelve a leer esto.

**Si un comando de shell de esta skill pide aprobacion al usuario**: antes
de lanzarlo, di en una frase que vas a ejecutar y por que (comprobar que
modelos hay disponibles via el CLI ya instalado - sin red, sin
credenciales) para que lo apruebe con confianza. **Si el usuario cancela
esa aprobacion o el comando falla**: para ahi mismo y preguntale
explicitamente que prefiere hacer - nunca sigas adelante rellenando el
hueco con una suposicion (como pedir una API key); es preferible preguntar
que inventar un camino alterno.

## Memoria compartida (carpeta unica, obligatoria)

Todo el estado vive en `.inharness/` dentro del directorio de trabajo
actual (creala si no existe) - es la misma convencion que usan las skills
equivalentes de Claude Code y Kimi, para que cualquiera de los tres pueda
retomar el trabajo:

- `.inharness/discovery.md` - resultado del ultimo Paso 0: CLIs disponibles,
  catalogo de modelos, que modelos pasaron preflight con exito, y fecha/hora.
  Es la cache que evita repetir descubrimiento en cada activacion.
- `.inharness/task.md` - tarea original, analisis, mapeo de tiers aprobado.
- `.inharness/assignment.md` - tabla de estado por fila (id, rol, tier,
  cli/modelo resuelto, archivos, depende-de, estado: pendiente/en curso/
  hecho/fallido/bloqueada-cupo). Actualizala tras cada fila, no al final.
- `.inharness/log/<id>-<cli>.log` - salida cruda de cada llamada.

**Protocolo del panel (`inharness status`):** el orquestador DEBE escribir
`.inharness/now.md` al arrancar cada fase y cada vez que cambie. Son tres
lineas: `QUE HAGO: ...`, `ESPERANDO: ...`, `SIGUIENTE: ...`. DEBE mantener
`assignment.md` con una fila por tarea, id estable y estado normalizado:
`pendiente`, `en curso`, `hecho`, `fallido` o `bloqueada-cupo`. Actualiza la
fila en cuanto cambie el estado.

Si `.inharness/assignment.md` ya existe con filas pendientes o
`bloqueada-cupo`, ofrece
continuar desde ahi en vez de replanificar desde cero.

## Eficiencia (lean, obligatorio - no es opcional)

El proposito entero de esto es alargar el cupo de las suscripciones, no
gastarlo en idas y venidas. Cada salto a otro CLI cuesta cupo de ESA
suscripcion y tokens de esta sesion - tratalos como recurso escaso:

- **Cachea el descubrimiento**: si `.inharness/discovery.md` existe y es de
  esta misma sesion de trabajo, NO repitas el Paso 0 completo - leelo y
  sigue. Solo refrescalo si: el usuario lo pide, es una tarea claramente
  distinta, o un comando real fallo por algo que el discovery deberia haber
  cazado.
- **Cachea el preflight**: si un modelo ya se probo con exito en
  `.inharness/discovery.md`, no lo vuelvas a probar antes de reusarlo.
- **Prompts a sub-agentes cortos y concretos**: la tarea y el alcance
  exactos, nada mas - no copies las reglas de esta skill en el prompt.
- **Verifica con el metodo mas barato que baste**: lee el diff o el archivo
  concreto, corre el test dirigido - no releas todo ni relances la suite
  completa si no hace falta.
- **Menos filas, mientras cada una siga siendo verificable por separado**:
  cada fila de mas en otro CLI es un arranque+cierre de sesion completo.
- **No narres en prosa cada paso propio**: informa solo lo que hace falta
  para aprobar/decidir y los resultados/fallos - no repitas el contenido de
  esta skill de vuelta.
- **Paralelo cuando no hay dependencia**: si dos o mas filas no dependen
  entre si, lanzalas todas seguidas con `runRow.js launch` (cada una abre
  su pestana y vuelve en segundos; ver Paso 3) y esperalas despues con
  `runRow.js wait`, en vez de esperar una a una en secuencia. Solo esperas de
  verdad a una fila cuando otra depende de ella.
- **Comprobacion proporcional, no narrada**: tras cada llamada, valida con
  lo minimo que baste segun lo que produce la fila. Si solo produce un
  documento o un archivo de datos, basta con el codigo de salida y que el
  archivo exista y no este vacio. Si produce **codigo**, el codigo de salida
  no prueba nada: ejecuta tu los tests o el comando que demuestre que
  funciona y lee su resultado. **Nunca des por bueno el autoinforme del
  sub-agente** ("tests en verde", "hecho"): es una afirmacion, no una
  prueba. Actualiza `.inharness/assignment.md` con
  una edicion de una linea por fila - no lo reescribas entero ni lo narres
  salvo que algo falle o necesite tu decision.

## Paso 0 - Descubrimiento en caliente

No asumas un catalogo de dias/sesiones anteriores, pero SI reusa el de esta
misma sesion si ya existe (ver "Eficiencia" arriba). Si toca refrescarlo:

```bash
kimi provider list
kimi provider list --json
claude --version
```

Verificacion de suscripcion (nunca API): Kimi debe mostrar `source=oauth`
en `provider list`; Claude, si el entorno tiene `ANTHROPIC_API_KEY` seteada
puede estar en modo API - avisa y excluyela si es asi. Tu (Codex) ya estas
autenticado por esta sesion.

**Aviso de version**: si `kimi --version` o `claude --version` difieren de
las ultimas verificadas con esta skill (Kimi 2.1.1, Claude 2.1.268),
dilo explicitamente antes de continuar - la sintaxis de abajo se probo
contra esas versiones.

**Preflight de modelos**: un modelo listado puede no estar habilitado en el
plan real (visto con `kimi-for-coding-highspeed`: aparece listado pero da
401 al invocarlo). Antes de comprometerte a un modelo que no hayas usado ya
en esta sesion, lanzale un prompt trivial de una linea para confirmar que
responde.

## Paso 1 - Mapeo de modelos por complejidad (una vez, no por tarea)

```
alta  : <cli>/<modelo> [@ esfuerzo]   (puede haber 2+)
media : <cli>/<modelo> [@ esfuerzo]
baja  : <cli>/<modelo> [@ esfuerzo]
```

No pongas por defecto el modelo mas nuevo/nombrado en "alta" solo por su
nombre - mira los metadatos reales del catalogo (effort por defecto,
contexto). Muestralo en 3-4 lineas, nunca en parrafos.

Para cada nivel, anota tambien un **respaldo** en otro CLI (p. ej.
`media: kimi/kimi-for-coding - respaldo: claude/sonnet`). Las suscripciones
tienen cupos (ventanas de 5 horas, limites semanales) y se agotan a mitad
de trabajo: el respaldo decidido de antemano evita improvisar cuando pase
(ver "Fila cortada por cupo" en el Paso 3).

## Paso 2 - Entender la tarea y proponer el reparto

2-3 frases: que tan acotada esta la tarea y por que el numero de filas
propuesto es el que hace falta (nunca una plantilla fija de roles). Cada
fila: que hace (frase corta), tier, archivos (sin solape - usa
depends_on si dos filas comparten archivo), de que depende.

**Busca primero paralelismo real antes de resolverlo en una sola fila.**
No preguntes solo "cuantas piezas hacen falta" sino "que angulos de esta
tarea son realmente independientes entre si" (ej: en una auditoria,
seguridad / portabilidad / consistencia de docs son revisiones distintas,
cada una a un CLI/modelo distinto). Esto incluye al propio CLI director -
tu mismo -: si uno de esos angulos lo puedes resolver tu, es una fila mas,
no solo "el que coordina" - resuelvela inline en esta misma sesion, sin
lanzar un `codex exec` anidado sobre ti mismo. No anula la regla de arriba:
una tarea sin angulos independientes sigue siendo 1 sola fila - lo que
cambia es que hay que comprobarlo cada vez, no resolverlo todo en el
primer CLI que venga a la cabeza.

**Ficheros compartidos: solo los toca el orquestador.** El "sin solape" no
basta con los ficheros que usan varias filas a la vez aunque ninguna los
"posea": configuracion de tests (`conftest.py`, `pytest.ini`,
`jest.config.*`), manifiestos y dependencias (`pyproject.toml`,
`package.json`, lockfiles) y modulos comunes que importan varias filas. No
los asignes a filas que corren en paralelo: preparalos tu antes de
lanzarlas, o despues con lo que pidan. Indica en el prompt de cada fila que
no los modifique y que, si necesita un cambio, lo diga en su resumen.

Regla dura: si una fila audita/testea el trabajo de otra, resuelvela a un
CLI DISTINTO al de la fila que produjo ese trabajo. La fila de verificacion
contrasta resultados reales (ejecuta los tests, compara la salida con lo
pedido) y no se limita a leer el resumen de la fila verificada.

Presentalo al usuario y espera su aprobacion explicita (o edicion del
mapeo) antes de ejecutar nada.

## Paso 3 - Ejecutar (solo lo aprobado)

**Filas de codex (tu mismo):** resuelvelas con tus herramientas en esta
sesion; no te invoques como subproceso.

**Codex:** el sandbox `workspace-write` no tiene red. No asignes a esa fila
instalar dependencias ni probar servicios en vivo; prepara tu las
dependencias y deja esas pruebas a otra fila. Indicalo en el prompt.
`--effort` admite low|medium|high|xhigh|max|ultra; usa un valor admitido por
el modelo del catalogo. `--sandbox` admite workspace-write (por defecto)
o read-only; no se aplica a Kimi ni a Claude.

**Kimi:** el prefijo `kimi-code/` se anade automaticamente. Nunca `--auto`
ni `-y` en modo `-p`. Usa el esfuerzo predeterminado del modelo.

**Claude externo:** recibe el prompt por stdin, con `--model`,
`--permission-mode acceptEdits` y `--add-dir`; nunca `--bare`.
`acceptEdits` permite editar archivos, pero no autoriza Bash en general:
una herramienta sin permiso puede ser denegada o requerir aprobacion y
agotar el timeout. Revisa `wait` y el log; prepara permisos concretos en
una sesion interactiva o reasigna la fila. No actives bypass de permisos.

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
El hook de Codex se instala en `~/.codex/hooks.json`; acepta su confianza
una vez en `/hooks` si aparece como untrusted.

Escribe el prompt autocontenido con el editor en
`.inharness/prompts/<id>.md`. Los ejemplos siguientes usan la fila 3:
crea primero `.inharness/prompts/3.md` y adapta id, CLI, modelo y esfuerzo
al reparto aprobado. Son el mismo texto en bash, Git Bash y PowerShell.
`--cwd` fija la raiz explicita; el prompt debe estar dentro de ella,
tambien tras resolver enlaces: fichero regular UTF-8, sin controles
binarios, de hasta 1 MiB. Los logs y su estado no admiten enlaces.

```bash
# kimi
node "$HOME/.inharness/runtime/runRow.js" launch --id 3 --cli kimi --model kimi-for-coding --prompt-file .inharness/prompts/3.md

# claude
node "$HOME/.inharness/runtime/runRow.js" launch --id 3 --cli claude --model sonnet --prompt-file .inharness/prompts/3.md
```

Codex y Claude reciben el prompt por stdin. Kimi lo recibe como argumento
hasta 20000 caracteres, siempre que la linea completa escapada quepa en
CreateProcess (32767 unidades UTF-16 con el NUL final). Si no cabe, recibe
una instruccion con la ruta relativa citada en JSON para leer el fichero.
No se ha vuelto a verificar aqui el soporte de stdin de Kimi.
Codex anade `--output-last-message .inharness/log/<id>-codex-last.txt`.

`launch` imprime una linea JSON con id, cli, mode, pid, log, visible y window
(warning si no hay ventana; si la pestana no arranca, codigo 1); mode es pane,
tab o fallback. El log esta en `.inharness/log/<id>-<cli>.log`.
Cuando otra fila dependa de esta, usa `wait`: devuelve 0 si ok, 1 si fallo,
y JSON con exitCode, aborted, timedOut, error y outputTail (4000 caracteres).
`status` no bloquea: running | done | aborted | unknown. Errores de uso,
incluido un id ya ocupado (EBUSY), devuelven 2.
Limitacion pendiente del launcher: en fallback no hay reserva de id;
no lances dos filas con el mismo id/CLI a la vez, pues pueden pisar el log.

```bash
node "$HOME/.inharness/runtime/runRow.js" wait --id 3 --cli kimi --timeout-ms 600000
node "$HOME/.inharness/runtime/runRow.js" status --id 3 --cli kimi
node "$HOME/.inharness/runtime/runRow.js" wait --id 3 --cli claude --timeout-ms 600000
node "$HOME/.inharness/runtime/runRow.js" status --id 3 --cli claude
```

Verifica cada fila antes de darla por buena: lee los archivos y ejecuta
los tests si produce codigo. Actualiza su estado en
`.inharness/assignment.md` inmediatamente despues de cada fila.

**Fila cortada por cupo.** Si un CLI responde con un limite de uso ("usage
limit", "quota", "rate limit", un 403/429 que hable de cupo o de la ventana
de 5 horas) o se queda sin responder dentro de su tiempo maximo:
1. Marca la fila `bloqueada-cupo` en `.inharness/assignment.md`, con la hora
   y el mensaje recibido.
2. Relanzala en el **respaldo** de su nivel (Paso 1). Dale en el prompt lo
   que la fila anterior ya dejo hecho (ficheros parciales) para que continue
   y no empiece de cero. Avisa al usuario en una linea.
3. Si el respaldo tambien esta limitado, deja la fila en `bloqueada-cupo` y
   dilo. Al retomar el trabajo mas tarde, las filas `bloqueada-cupo` se
   reintentan antes que las pendientes.

## Paso 4 - QA final y cierre

Revisa el conjunto contra lo pedido, reporta que hizo cada fila (rol -
cli/modelo - resultado) en una lista corta, y senala cualquier fallo o
modelo excluido (401, version no verificada) en vez de omitirlo. Deja
`.inharness/assignment.md` con el estado final real.
