//! Model keys belong to the current Windows user's credential set, not app files.
use url::Url;

const PREFIX: &str = "ai.hexglow.desktop/model-key/v1/";
const MAX_KEY_BYTES: usize = 2560;

fn target_name(destination: &str) -> Result<String, String> {
    if destination.len() > 2048 {
        return Err("模型服务地址过长".into());
    }
    let (provider, address) = destination.split_once(':').ok_or("模型服务地址无效")?;
    if !matches!(provider, "openai" | "jev") {
        return Err("模型协议无效".into());
    }
    let url = Url::parse(address).map_err(|_| "模型服务地址无效")?;
    let local = matches!(url.host(), Some(url::Host::Ipv4(ip)) if ip.octets()[0..3] == [127, 0, 0])
        || matches!(url.host(), Some(url::Host::Ipv6(ip)) if ip.is_loopback());
    if url.host().is_none()
        || (url.scheme() != "https" && !(url.scheme() == "http" && local))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("密钥只能绑定有效的 HTTPS 或本机 HTTP 模型服务".into());
    }
    let identity = format!(
        "{provider}:{}{}",
        url.origin().ascii_serialization(),
        url.path().trim_end_matches('/')
    );
    // Hex encoding avoids wildcard characters in Windows credential target names.
    let encoded: String = identity
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(format!("{PREFIX}{encoded}"))
}

fn validate_key(key: &str) -> Result<(), String> {
    if key.len() > MAX_KEY_BYTES || key.chars().any(char::is_control) {
        return Err("API Key 过长或含有控制字符，请检查后重填".into());
    }
    Ok(())
}

#[cfg(windows)]
mod native {
    use super::MAX_KEY_BYTES;
    use windows::{
        core::{HRESULT, PCWSTR, PWSTR},
        Win32::{
            Foundation::ERROR_NOT_FOUND,
            Security::Credentials::{
                CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW,
                CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
            },
        },
    };

    fn missing(error: &windows::core::Error) -> bool {
        error.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0)
    }

    pub fn read(target: &str) -> Result<Option<String>, String> {
        let name: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
        let mut entry = std::ptr::null_mut::<CREDENTIALW>();
        // SAFETY: name is NUL-terminated; Windows owns the returned allocation until CredFree.
        unsafe {
            if let Err(error) =
                CredReadW(PCWSTR(name.as_ptr()), CRED_TYPE_GENERIC, None, &mut entry)
            {
                return if missing(&error) {
                    Ok(None)
                } else {
                    Err("无法读取 Windows 保存的密钥，请重新填写或稍后重试".into())
                };
            }
            if entry.is_null() {
                return Err("Windows 密钥记录无效，请重新保存".into());
            }
            let credential = &*entry;
            let size = credential.CredentialBlobSize as usize;
            let result = if size == 0 {
                Ok(None)
            } else if size > MAX_KEY_BYTES || credential.CredentialBlob.is_null() {
                Err("Windows 密钥记录无效，请重新保存".into())
            } else {
                let blob = std::slice::from_raw_parts_mut(credential.CredentialBlob, size);
                let decoded = std::str::from_utf8(blob)
                    .map(str::to_owned)
                    .map_err(|_| "Windows 密钥记录无法读取，请重新保存".into());
                blob.fill(0);
                decoded.map(Some)
            };
            CredFree(entry.cast());
            result
        }
    }

    pub fn write(target: &str, key: &str) -> Result<(), String> {
        let mut name: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
        // Clearing only deletes the exact Hexglow service entry, never other credentials.
        if key.trim().is_empty() {
            // SAFETY: name is NUL-terminated and remains alive throughout the call.
            return unsafe {
                CredDeleteW(PCWSTR(name.as_ptr()), CRED_TYPE_GENERIC, None).or_else(|error| {
                    if missing(&error) {
                        Ok(())
                    } else {
                        Err(error)
                    }
                })
            }
            .map_err(|_| "无法删除 Windows 保存的密钥，请稍后重试".into());
        }
        let mut blob = key.as_bytes().to_vec();
        let entry = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(name.as_mut_ptr()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        // SAFETY: entry's pointers refer to live buffers; CredWrite copies their contents.
        let result = unsafe { CredWriteW(&entry, 0) };
        blob.fill(0);
        result.map_err(|_| "无法保存到 Windows 凭据管理器，请稍后重试".into())
    }
}

#[tauri::command(async)]
pub fn model_key_load(
    window: tauri::WebviewWindow,
    destination: String,
) -> Result<Option<String>, String> {
    if window.label() != "main" {
        return Err("仅主窗口可以读取模型密钥".into());
    }
    let target = target_name(&destination)?;
    #[cfg(windows)]
    {
        native::read(&target)
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        Err("密钥持久化目前仅支持 Windows".into())
    }
}

#[tauri::command(async)]
pub fn model_key_save(
    window: tauri::WebviewWindow,
    destination: String,
    api_key: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("仅主窗口可以保存模型密钥".into());
    }
    let target = target_name(&destination)?;
    validate_key(&api_key)?;
    #[cfg(windows)]
    {
        native::write(&target, &api_key)
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        Err("密钥持久化目前仅支持 Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_identity_is_version_independent_and_normalized() {
        assert_eq!(
            target_name("openai:https://EXAMPLE.test:443/v1/").unwrap(),
            target_name("openai:https://example.test/v1").unwrap()
        );
        let base = target_name("openai:https://example.test/v1").unwrap();
        assert!(base.starts_with(PREFIX));
        for other in [
            "jev:https://example.test/v1",
            "openai:https://other.test/v1",
            "openai:https://example.test/v2",
            "openai:https://example.test:8443/v1",
        ] {
            assert_ne!(base, target_name(other).unwrap());
        }
    }

    #[test]
    fn rejects_ambiguous_destinations_without_echoing_values() {
        for value in [
            "other:https://example.test",
            "openai:https://user:synthetic-secret@example.test",
            "openai:https://example.test?key=synthetic-secret",
            "openai:https://example.test#synthetic-secret",
            "openai:http://example.test",
            "openai:file:///test",
        ] {
            let error = target_name(value).unwrap_err();
            assert!(!error.contains("synthetic-secret"));
        }
    }

    #[test]
    fn bounds_keys_and_rejects_control_characters() {
        assert!(validate_key("synthetic-test-key").is_ok());
        assert!(validate_key("").is_ok());
        assert!(validate_key("line\nkey").is_err());
        assert!(validate_key(&"x".repeat(MAX_KEY_BYTES + 1)).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_store_roundtrip_overwrite_and_delete_are_isolated() {
        let target = target_name(&format!(
            "openai:https://credential-test.invalid/{}",
            uuid::Uuid::new_v4()
        ))
        .unwrap();
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = native::write(&self.0, "");
            }
        }
        let _cleanup = Cleanup(target.clone());
        assert_eq!(native::read(&target).unwrap(), None);
        native::write(&target, "synthetic-only-first-key").unwrap();
        assert_eq!(
            native::read(&target).unwrap().as_deref(),
            Some("synthetic-only-first-key")
        );
        native::write(&target, "synthetic-only-replaced-key").unwrap();
        assert_eq!(
            native::read(&target).unwrap().as_deref(),
            Some("synthetic-only-replaced-key")
        );
        native::write(&target, "").unwrap();
        assert_eq!(native::read(&target).unwrap(), None);
        native::write(&target, "").unwrap();
    }
}
