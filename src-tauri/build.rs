fn main() {
    // Встраиваем в .exe манифест через встроенный механизм Tauri (НЕ через
    // отдельный winres::WindowsResource::compile() — тот создаёт свой
    // независимый Windows-ресурс VERSION, который конфликтует с ресурсом,
    // который tauri_build уже генерирует сам, и линковщик падает с
    // ошибкой "CVT1100: duplicate resource").
    //
    // Манифест обязательно содержит:
    //  - requireAdministrator — чтобы Windows сама показывала UAC при
    //    запуске, без ручного "Запуск от имени администратора";
    //  - зависимость на Common Controls v6 — без неё WebView2 не находит
    //    TaskDialogIndirect в comctl32.dll и падает сразу при старте с
    //    ошибкой "точка входа не найдена".
    #[cfg(target_os = "windows")]
    {
        let windows = tauri_build::WindowsAttributes::new().app_manifest(
            r#"
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="requireAdministrator" uiAccess="false" />
      </requestedPrivileges>
    </security>
  </trustInfo>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#,
        );
        let attributes = tauri_build::Attributes::new().windows_attributes(windows);
        tauri_build::try_build(attributes).expect("Не удалось встроить манифест администратора");
    }

    #[cfg(not(target_os = "windows"))]
    tauri_build::build();
}
