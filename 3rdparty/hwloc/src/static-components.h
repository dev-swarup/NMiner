HWLOC_DECLSPEC extern const struct hwloc_component hwloc_noos_component;
HWLOC_DECLSPEC extern const struct hwloc_component hwloc_xml_component;
HWLOC_DECLSPEC extern const struct hwloc_component hwloc_synthetic_component;
HWLOC_DECLSPEC extern const struct hwloc_component hwloc_xml_nolibxml_component;
#ifdef _WIN32
HWLOC_DECLSPEC extern const struct hwloc_component hwloc_windows_component;
#elif defined(HWLOC_LINUX_SYS)
HWLOC_DECLSPEC extern const struct hwloc_component hwloc_linux_component;
#endif

#if defined(__i386__) || defined(__x86_64__) || defined(_M_IX86) || defined(_M_X64)
HWLOC_DECLSPEC extern const struct hwloc_component hwloc_x86_component;
#endif

static const struct hwloc_component * hwloc_static_components[] = {
  &hwloc_noos_component,
  &hwloc_xml_component,
  &hwloc_synthetic_component,
  &hwloc_xml_nolibxml_component,
#ifdef _WIN32
  &hwloc_windows_component,
#elif defined(HWLOC_LINUX_SYS)
  &hwloc_linux_component,
#endif
#if defined(__i386__) || defined(__x86_64__) || defined(_M_IX86) || defined(_M_X64)
  &hwloc_x86_component,
#endif
  NULL
};
