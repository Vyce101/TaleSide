"""Protect saved provider secrets with Windows DPAPI for the current user."""

from ctypes import POINTER, Structure, byref, cast, create_string_buffer, string_at
from ctypes.wintypes import BOOL, BYTE, DWORD, HLOCAL, LPCWSTR, LPWSTR, LPVOID


class DataBlob(Structure):
    _fields_ = [("size", DWORD), ("bytes", POINTER(BYTE))]


def protect(secret):
    return _transform(secret.encode("utf-8"), decrypt=False)


def unprotect(ciphertext):
    return _transform(ciphertext, decrypt=True).decode("utf-8")


def _transform(value, *, decrypt):
    from ctypes import WinDLL, WinError, get_last_error

    crypt = WinDLL("crypt32", use_last_error=True)
    kernel = WinDLL("kernel32")
    kernel.LocalFree.argtypes = [HLOCAL]
    kernel.LocalFree.restype = HLOCAL
    operation = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    description_type = POINTER(LPWSTR) if decrypt else LPCWSTR
    operation.argtypes = [POINTER(DataBlob), description_type, POINTER(DataBlob), LPVOID,
                          LPVOID, DWORD, POINTER(DataBlob)]
    operation.restype = BOOL
    buffer = create_string_buffer(value)
    source = DataBlob(len(value), cast(buffer, POINTER(BYTE)))
    output = DataBlob()
    no_prompt = 0x1  # CRYPTPROTECT_UI_FORBIDDEN
    if not operation(byref(source), None, None, None, None, no_prompt, byref(output)):
        raise WinError(get_last_error())
    try:
        return string_at(output.bytes, output.size)
    finally:
        kernel.LocalFree(cast(output.bytes, HLOCAL))
