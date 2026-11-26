# Orca Plugins

**Pi Durable** añade un listado de agentes en inglés a Orca. Al seleccionar un agente local se abre **Pi Chat** en una pestaña central del workspace. **Details** muestra el historial guardado en SQLite y **Edit** permite cambiar las instrucciones, el nombre y el modelo conservando el identificador. [Guía completa de Pi Durable e instalación en inglés](plugins/pi-durable/README.md)

## Instalar Pi Durable

La integración se probó con Orca Desktop 1.4.278 para Windows, Node.js 24 y Pi Coding Agent 1.4.0. Necesitas también npm y Git.

1. Si aún no tienes Pi, ejecuta `npm install -g @earendil-works/pi-coding-agent@1.4.0`. Comprueba que Pi aparece en **Settings → Agents** de Orca.
2. Descarga la versión, registra el proveedor local en Pi e inicia el servicio.

   ```sh
   git clone --branch pi-durable-v0.3.0 https://github.com/gvillarroel/orca-plugins.git
   cd orca-plugins
   pi install ./integrations/pi-durable-provider
   cd runtime
   npm ci
   npm start
   ```

   Conserva la carpeta en esa ubicación y deja el servicio en ejecución mientras usas tus agentes.

3. Añade el catálogo `https://github.com/gvillarroel/orca-plugins.git`, ref `main`, en **Settings → Plugins**. Instala **Pi Durable** y revisa los permisos de Orca.
4. Abre un workspace local y selecciona **Pi Durable → + Recruit** en la barra derecha. Escribe un nombre y elige `demo`. Al guardar, escribe un mensaje en la pestaña central. El modelo de demostración devuelve un eco local.

Si ya tienes Pi Durable, actualiza el servicio local, el proveedor de Pi y el plugin de Orca. El servicio vuelve a abrir tu base de datos. [Actualizar una instalación anterior](plugins/pi-durable/README.md#upgrade-an-existing-installation)

En una pestaña nativa puedes mencionar archivos con `@`. Con un perfil que admite herramientas, Pi puede leer un archivo del workspace y Orca muestra la operación junto a la respuesta. [Captura de la lectura en Orca](docs/pi-durable/native-tool.png)

## Evolucionar y borrar agentes

En **Details → Evolve** escribe un requisito y pulsa **Generate proposal**. Un agente editor recibe el código del agente seleccionado y prepara una nueva función JavaScript. Puedes elegir el modelo del editor por separado y usar **Add an example** para fijar un mensaje y la respuesta que esperas. El servicio ejecuta los ejemplos y comprueba que la propuesta conserve el comportamiento cubierto por las pruebas anteriores.

Para probarlo sin credenciales, selecciona el editor `demo` y escribe `Cuando diga "estado", responde "listo"`. Revisa **Proposed script** y **Passed checks**, pulsa **Apply change** y escribe `estado` en el mismo chat de Orca. El agente responderá `listo`, incluso después de reiniciar el servicio. **Active script → Restore previous script** recupera la versión anterior. El editor de demostración admite respuestas a frases exactas y comandos para contar palabras. Un editor con modelo configurado puede generar otras transformaciones de texto. [Guía de evolución](plugins/pi-durable/README.md#evolve-a-local-agent)

Para borrar un agente local, abre **Details → Edit → Delete agent…** y confirma el nombre y el ID que muestra Orca. El agente desaparece del listado, deja de aceptar mensajes y su ID queda reservado. Los historiales previos se conservan en SQLite y en las pestañas de Orca.

Cada plugin se distribuye desde su carpeta en `plugins/<id>/`. El catálogo raíz fija la versión, el commit y el hash de cada publicación. [Catálogo](orca-catalog.json) · [Licencia MIT](LICENSE)
