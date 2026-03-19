import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Slider,
} from "@heroui/react";
import { useTranslation } from "next-i18next";

type BrightnessModalProps = {
  show: boolean;
  brightness: number;
  min: number;
  max: number;
  onBrightnessChange: (value: number | number[]) => void;
  onClose: () => void;
  onReset: () => void;
};

function BrightnessModal(props: BrightnessModalProps) {
  const { t } = useTranslation("stream");

  return (
    <Modal isOpen={props.show} onClose={props.onClose} size="md">
      <ModalContent>
        <>
          <ModalHeader>{t("Brightness adjustment")}</ModalHeader>
          <ModalBody className="gap-4">
            <Slider
              label={t("Brightness")}
              minValue={props.min}
              maxValue={props.max}
              step={1}
              value={props.brightness}
              onChange={props.onBrightnessChange}
              showTooltip
            />
            <div className="text-sm text-default-500">
              {t("Current brightness")}: {props.brightness}%
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={props.onReset}>
              {t("Reset")}
            </Button>
            <Button color="primary" onPress={props.onClose}>
              {t("Confirm")}
            </Button>
          </ModalFooter>
        </>
      </ModalContent>
    </Modal>
  );
}

export default BrightnessModal;
