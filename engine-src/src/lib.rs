use legal_structure::{
    provider_text_document_structure, DocumentStructure, ProviderTextInput, ENGINE_SOURCE_SHA256,
};
use serde::Serialize;
use std::{cell::RefCell, slice};

thread_local! {
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[derive(Serialize)]
struct BrowserStructure<'a> {
    ok: bool,
    engine_source_sha256: &'static str,
    offset_unit: &'a str,
    text_sha256: &'a str,
    nodes: &'a [legal_structure::StructureNode],
}

#[derive(Serialize)]
struct BrowserError<'a> {
    ok: bool,
    error: &'a str,
}

fn encode(input: &[u8]) -> Vec<u8> {
    let result = std::str::from_utf8(input)
        .map_err(|error| error.to_string())
        .and_then(|json| {
            serde_json::from_str::<ProviderTextInput>(json).map_err(|error| error.to_string())
        })
        .and_then(|input| {
            provider_text_document_structure(input).map_err(|error| error.to_string())
        });

    match result {
        Ok(DocumentStructure {
            offset_unit,
            text_sha256,
            nodes,
            ..
        }) => serde_json::to_vec(&BrowserStructure {
            ok: true,
            engine_source_sha256: ENGINE_SOURCE_SHA256,
            offset_unit: &offset_unit,
            text_sha256: &text_sha256,
            nodes: &nodes,
        })
        .expect("browser structure serialization is infallible"),
        Err(error) => serde_json::to_vec(&BrowserError {
            ok: false,
            error: &error,
        })
        .expect("browser error serialization is infallible"),
    }
}

#[no_mangle]
pub extern "C" fn legal_structure_alloc(length: usize) -> *mut u8 {
    Box::into_raw(vec![0_u8; length].into_boxed_slice()) as *mut u8
}

#[no_mangle]
pub unsafe extern "C" fn legal_structure_dealloc(pointer: *mut u8, length: usize) {
    if !pointer.is_null() {
        drop(Box::from_raw(slice::from_raw_parts_mut(pointer, length)));
    }
}

#[no_mangle]
pub unsafe extern "C" fn legal_structure_analyze(pointer: *const u8, length: usize) {
    let input = if pointer.is_null() {
        &[]
    } else {
        slice::from_raw_parts(pointer, length)
    };
    OUTPUT.with(|output| *output.borrow_mut() = encode(input));
}

#[no_mangle]
pub extern "C" fn legal_structure_output_pointer() -> *const u8 {
    OUTPUT.with(|output| output.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn legal_structure_output_length() -> usize {
    OUTPUT.with(|output| output.borrow().len())
}
