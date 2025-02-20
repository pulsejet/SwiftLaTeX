mergeInto(LibraryManager.library, {
  kpse_find_pk_js: function(nameptr, dpi) {
    return kpse_find_pk_impl(nameptr, dpi);
  }
});

